const { google } = require("googleapis");
const mysql = require("mysql2/promise");

const SHEET_ID = "1DCb3DM_9DEYaD7QB4pXkrQ8mVc9i02KrNyq8x-anPRY";
const SHEET_NAME = "CUMPLIMIENTO DIA ANTERIOR";

function convertirFecha(valor) {

  if (!valor) return null;

  valor = valor.toString().trim();

  let match = valor.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (match) {
    const dia = match[1].padStart(2, "0");
    const mes = match[2].padStart(2, "0");
    const anio = match[3];

    return `${anio}-${mes}-${dia} 00:00:00`;
  }

  match = valor.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/
  );

  if (match) {
    const dia = match[1].padStart(2, "0");
    const mes = match[2].padStart(2, "0");
    const anio = match[3];
    const hora = match[4].padStart(2, "0");
    const minuto = match[5];

    return `${anio}-${mes}-${dia} ${hora}:${minuto}:00`;
  }

  return valor;
}

function convertirHora(valor) {

  if (!valor) return null;

  valor = valor.toString().trim();

  let match = valor.match(/^(\d{1,2}):(\d{2})$/);

  if (match) {
    return `${match[1].padStart(2, "0")}:${match[2]}:00`;
  }

  match = valor.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);

  if (match) {
    return valor;
  }

  return valor;
}

const BATCH_SIZE = 100;

async function insertBatch(conn, columnas, placeholders, batchValues) {
  const rowPlaceholders = batchValues.map(() => `(${placeholders})`).join(",");
  const sql = `INSERT IGNORE INTO BASE_B2C (${columnas}) VALUES ${rowPlaceholders}`;
  const flat = batchValues.flat();

  await conn.beginTransaction();
  try {
    const [result] = await conn.query(sql, flat);
    await conn.commit();
    return result.affectedRows;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

async function main() {

  console.log("EJECUCION:", new Date().toISOString());

  let conn;

  try {

    console.log("================================");
    console.log("INICIANDO CARGA_BASE_B2C");
    console.log("================================");

    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: "service_account",
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      },
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets.readonly"
      ]
    });

    const sheets = google.sheets({
      version: "v4",
      auth
    });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME
    });

    const rows = response.data.values;

    if (!rows || rows.length < 2) {
      console.log("No hay datos para procesar");
      return;
    }

    const headers = rows[0];

    console.log(`Filas encontradas: ${rows.length - 1}`);
    console.log(`Columnas encontradas: ${headers.length}`);

    const columnasFecha = [
      "FECHA",
      "FECHA_PROGRAMACION",
      "HORA_CAMBIO_ESTADO",
      "FECHA_CANCELACION",
      "FECHA_CREACION_AGENDA",
      "FECHA_CARGA_SISTEMA",
      "STARTTIME",
      "ENDTIME",
      "FECHA_CARGUE_NORM",
      "FECHA_ENVIO",
      "STARTTIME_T",
      "ENDTIME_T"
    ];

    const columnasHora = [
      "HORA_INICIO_RANGO_INICIAL",
      "HORA_INICIO_RANGO_FINAL"
    ];

    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    console.log("Conectado a MySQL");

    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'BASE_B2C'`,
      [process.env.DB_NAME]
    );
    const tableCols = new Set(cols.map(c => c.COLUMN_NAME));

    const headersExistentes = headers.filter(h => tableCols.has(h));
    const headersIgnoradas = headers.filter(h => !tableCols.has(h));

    if (headersIgnoradas.length) {
      console.warn("Columnas del sheet ignoradas (no existen en BASE_B2C):");
      headersIgnoradas.forEach(h => console.warn("  - " + h));
    }

    console.log(`Columnas a insertar: ${headersExistentes.length} de ${headers.length}`);

    let insertados = 0;
    let omitidos = 0;
    let batchValues = [];

    const columnas = headersExistentes.join(",");
    const placeholders = headersExistentes.map(() => "?").join(",");

    for (let i = 1; i < rows.length; i++) {

      try {

        const fila = rows[i];

        const valores = headersExistentes.map((columna) => {

          const idx = headers.indexOf(columna);
          let valor = fila[idx];

          if (
            valor === undefined ||
            valor === null ||
            valor === ""
          ) {
            return null;
          }

          if (columnasFecha.includes(columna)) {
            return convertirFecha(valor);
          }

          if (columnasHora.includes(columna)) {
            return convertirHora(valor);
          }

          return valor;

        });

        batchValues.push(valores);

        if (batchValues.length >= BATCH_SIZE) {
          try {
            const inserted = await insertBatch(conn, columnas, placeholders, batchValues);
            insertados += inserted;
            omitidos += batchValues.length - inserted;
          } catch (batchError) {
            console.error(`ERROR en batch (última fila ${i}):`, batchError.message);
            omitidos += batchValues.length;
          }
          batchValues = [];
          console.log(`Procesadas: ${i} | Insertadas: ${insertados} | Omitidas: ${omitidos}`);
        }

      } catch (filaError) {

        console.error(`ERROR procesando fila ${i}:`, filaError.message);
        omitidos++;

      }

    }

    if (batchValues.length > 0) {
      try {
        const inserted = await insertBatch(conn, columnas, placeholders, batchValues);
        insertados += inserted;
        omitidos += batchValues.length - inserted;
      } catch (batchError) {
        console.error(`ERROR en batch final:`, batchError.message);
        omitidos += batchValues.length;
      }
      console.log(`Procesadas: ${rows.length - 1} | Insertadas: ${insertados} | Omitidas: ${omitidos}`);
    }

    console.log("================================");
    console.log("FINALIZADO");
    console.log(`Total procesadas: ${rows.length - 1}`);
    console.log(`Insertadas: ${insertados}`);
    console.log(`Omitidas (duplicadas o con error): ${omitidos}`);
    console.log("================================");

  } catch (error) {

    console.error("================================");
    console.error("ERROR GENERAL");
    console.error("================================");

    console.error(error.message);

    if (error.code) {
      console.error("CODE:", error.code);
    }

    if (error.sqlMessage) {
      console.error("SQL MESSAGE:", error.sqlMessage);
    }

    console.error(error);

  } finally {

    if (conn) {
      await conn.end();
    }

  }

}

main().catch((err) => {
  console.error("================================");
  console.error("ERROR NO CONTROLADO EN main()");
  console.error("================================");
  console.error(err);
  process.exit(1);
});
