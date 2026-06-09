const { google } = require("googleapis");
const mysql = require("mysql2/promise");

const SHEET_ID = "1DCb3DM_9DEYaD7QB4pXkrQ8mVc9i02KrNyq8x-anPRY";
const SHEET_NAME = "CUMPLIMIENTO DIA ANTERIOR";

async function main() {
  try {

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({
      version: "v4",
      auth,
    });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME,
    });

    const rows = response.data.values;

    if (!rows || rows.length < 2) {
      console.log("No hay datos");
      return;
    }

    const headers = rows[0];

    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });

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

      const valores = headers.map((_, idx) =>
        fila[idx] === undefined || fila[idx] === ""
          ? null
          : fila[idx]
      );

      await conn.execute(sql, valores);

      insertados++;

    }

    await conn.end();

    console.log(`Insertados ${insertados} registros`);

  } catch (error) {
    console.error(error);
  }
}

main();
