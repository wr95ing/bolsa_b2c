const { google } = require("googleapis");
const mysql = require("mysql2/promise");

const SHEET_ID = "1DCb3DM_9DEYaD7QB4pXkrQ8mVc9i02KrNyq8x-anPRY";
const SHEET_NAME = "CUMPLIMIENTO DIA ANTERIOR";

function convertirFecha(valor) {

  if (!valor) return null;

  valor = valor.toString().trim();

  // Formato: 6/6/2026
  let match = valor.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (match) {
    const dia = match[1].padStart(2, "0");
    const mes = match[2].padStart(2, "0");
    const anio = match[3];

    return `${anio}-${mes}-${dia} 00:00:00`;
  }

  // Formato: 6/6/2026 14:35
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

async function main() {

  try {

    console.log("================================");
    console.log("INICIANDO CARGA BASE_B2C");
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

    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    console.log("Conectado a MySQL");

    let insertados = 0;

    for (let i = 1; i < rows.length; i++) {

      const fila = rows[i];

      const columnas = headers.join(",");

      const placeholders = headers.map(() => "?").join(",");

      const sql = `
        INSERT INTO BASE_B2C
        (${columnas})
        VALUES (${placeholders})
      `;

      const valores = headers.map((columna, idx) => {

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

        return valor;

      });

      await conn.execute(sql, valores);

      insertados++;

      if (insertados % 500 === 0) {
        console.log(`Insertados: ${insertados}`);
      }

    }

    await conn.end();

    console.log("======================");
    console.log(`Insertados: ${insertados}`);
    console.log("Proceso finalizado");
    console.log("======================");

  } catch (error) {

    console.error("ERROR:");
    console.error(error);

  }

}

main();
