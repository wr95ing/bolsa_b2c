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
    let errores = 0;

    const columnas = headersExistentes.join(",");
    const placeholders = headersExistentes.map(() => "?").join(",");

    const sql = `
      INSERT INTO BASE_B2C
      (${columnas})
      VALUES (${placeholders})
    `;

    for (let i = 1; i < rows.length; i++) {

      try {

        const fila = rows[i];

        console.log(`Procesando fila ${i}`);

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

        await conn.execute(sql, valores);

        insertados++;

        if (insertados % 100 === 0) {
          console.log(`Insertados: ${insertados}`);
        }

      } catch (filaError) {

        console.error("================================");
        console.error(`ERROR FILA ${i}`);
        console.error("================================");

        console.error(filaError);

        if (filaError.message) {
          console.error("MESSAGE:", filaError.message);
        }

        if (filaError.code) {
          console.error("CODE:", filaError.code);
        }

        if (filaError.sqlMessage) {
          console.error("SQL MESSAGE:", filaError.sqlMessage);
        }

        throw filaError;
      }

    }

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
