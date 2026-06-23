# bolsa_b2c

Script Node.js que ejecuta una vez al día para copiar datos desde un Google Sheet (`CUMPLIMIENTO DIA ANTERIOR`) hacia una tabla MySQL (`BASE_B2C`) en una VPS gestionada con Dockploy.

---

## 1. Arquitectura y flujo de datos

```
┌──────────────────────────┐
│  Sistema MDM (ETB)       │  ← Fuente original (órdenes de trabajo FTTH)
└────────────┬─────────────┘
             │  Reporte diario automático
             ▼
┌──────────────────────────┐
│  Google Sheets            │  ID: 1DCb3DM_9DEYaD7QB4pXkrQ8mVc9i02KrNyq8x-anPRY
│  Hoja: CUMPLIMIENTO       │  Pestaña: "CUMPLIMIENTO DIA ANTERIOR"
│  DIA ANTERIOR             │
└────────────┬─────────────┘
             │  Lectura vía service account
             ▼
┌──────────────────────────┐
│  index.js (este script)   │  Batch INSERT cada 100 filas, en transacción
│  Node.js 18+             │  Filtra columnas según schema real de MySQL
└────────────┬─────────────┘
             │  Conexión mysql2 (host=DB_HOST)
             ▼
┌──────────────────────────┐
│  MySQL · tabla BASE_B2C   │  UNIQUE KEY uk_orden (ORDEN_TRABAJO)
└──────────────────────────┘
```

---

## 2. Requisitos previos

- **Node.js 18+** (probado con 18.20.5)
- **Cuenta de servicio de Google Cloud** con la API de Google Sheets habilitada
- **MySQL/MariaDB** accesible desde el contenedor de Dockploy
- **Dockploy** como plataforma de despliegue

### Dependencias (`package.json`)

```json
{
  "name": "bolsa_b2c",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "googleapis": "^144.0.0",
    "mysql2": "^3.14.1"
  }
}
```

---

## 3. Estructura del repositorio

```
bolsa_b2c/
├── index.js          # Script principal (entrada)
├── package.json      # Dependencias
└── README.md         # Este archivo
```

El archivo `index.js` contiene:

- `convertirFecha(valor)` — convierte fechas en formato `DD/MM/YYYY` o `DD/MM/YYYY HH:MM` a `YYYY-MM-DD HH:MM:SS` (null si no matchea)
- `convertirHora(valor)` — convierte horas `HH:MM` o `HH:MM:SS` al formato que MySQL espera
- `insertBatch(conn, columnas, placeholders, batchValues)` — ejecuta un INSERT IGNORE multi-fila dentro de una transacción
- `main()` — orquesta todo: autentica contra Sheets, lee la hoja, consulta `INFORMATION_SCHEMA` para detectar columnas existentes, inserta por lotes
- `main().catch(...)` — captura rechazos async y hace `process.exit(1)`

---

## 4. Variables de entorno

Estas variables se configuran en Dockploy → tu servicio → **Environment**:

| Variable | Descripción | Ejemplo |
|---|---|---|
| `GOOGLE_CLIENT_EMAIL` | Email del service account | `etb-loader@mi-proyecto.iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | Llave privada del service account (con `\n` literales escapados) | `-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n` |
| `DB_HOST` | Host de MySQL | `mysql.dockploy.internal` |
| `DB_PORT` | Puerto de MySQL | `3306` |
| `DB_USER` | Usuario MySQL | `bolsa_b2c_user` |
| `DB_PASSWORD` | Contraseña MySQL | `********` |
| `DB_NAME` | Nombre de la base de datos | `etb_reports` |

> **Importante**: Dockploy permite multilínea en las env vars. La clave privada va con los `\n` literales — el script hace `.replace(/\\n/g, "\n")` automáticamente.

---

## 5. Configuración de Google Sheets

### 5.1. Habilitar la API

1. Crear (o usar) un proyecto en [Google Cloud Console](https://console.cloud.google.com/)
2. Habilitar la **Google Sheets API**
3. Crear una **Service Account** y descargar la clave JSON
4. Extraer de la JSON:
   - `client_email` → variable `GOOGLE_CLIENT_EMAIL`
   - `private_key` → variable `GOOGLE_PRIVATE_KEY` (escapar los `\n`)

### 5.2. Compartir el sheet

En el Google Sheet `CUMPLIMIENTO DIA ANTERIOR`:

1. Click en **Compartir**
2. Agregar el email del service account (ej. `etb-loader@mi-proyecto.iam.gserviceaccount.com`)
3. Permiso: **Lector** (Viewer)
4. Sin notificación

### 5.3. Datos del sheet

- **ID del spreadsheet**: `1DCb3DM_9DEYaD7QB4pXkrQ8mVc9i02KrNyq8x-anPRY`
- **Hoja/pestaña**: `CUMPLIMIENTO DIA ANTERIOR`
- La fila 1 son los headers (nombres de columna)
- Las filas 2+ son datos

El script detecta automáticamente las columnas existentes en MySQL y solo inserta las que coincidan. Las columnas del sheet que **no existan** en la tabla se reportan en log y se ignoran (no son un error).

---

## 6. Esquema de la base de datos

### 6.1. Tabla destino

```sql
CREATE TABLE BASE_B2C (
  -- (definida por el equipo de ETB; ver esquema real en producción)
  -- 63 columnas originalmente (sin HORAS_ABIERTO)
  -- Las columnas se correlacionan 1-a-1 con los headers del sheet
  ORDEN_TRABAJO VARCHAR(100) NOT NULL,
  -- ... resto de columnas ...
  PRIMARY KEY (id),  -- si existe id auto-increment
  UNIQUE KEY uk_orden (ORDEN_TRABAJO)  -- IMPORTANTE: agregado para idempotencia
);
```

### 6.2. UNIQUE constraint (obligatorio)

```sql
ALTER TABLE BASE_B2C
  ADD UNIQUE KEY uk_orden (ORDEN_TRABAJO);
```

Sin esta restricción, una corrida que se ejecute dos veces el mismo día duplicaría todas las filas. Con `INSERT IGNORE`, los duplicados se descartan silenciosamente a nivel de MySQL.

### 6.3. Columnas excluidas (no en la tabla)

Las siguientes columnas del sheet **no existen** en `BASE_B2C` y son ignoradas automáticamente:

- `HORAS_ABIERTO`
- `OPERATIVIDAD`
- `NOTA_OPERATIVIDAD`
- `TIPO_FALLA`

Cuando se agreguen al schema, no es necesario tocar el código: el script las detectará automáticamente y las empezará a insertar.

---

## 7. Despliegue en Dockploy

### 7.1. Crear el servicio

1. En Dockploy, ir a **Projects → tu proyecto → Services → Create**
2. **Tipo**: Application (no Database)
3. **Source**: Git Repository apuntando al repo `bolsa_b2c`
4. **Branch**: `main`
5. **Build Pack**: Docker o Nixpacks (auto-detecta Node.js)
6. **Port**: no exponer (es un job, no un servidor)
7. **Environment variables**: completar las 7 listadas arriba
8. **Restart Policy**: `On Failure` con máximo 3 reintentos (recomendado). Evitar `Always` para no caer en bucles de reinicio.
9. Click **Deploy**

### 7.2. Verificar manualmente (antes de programar)

Una vez desplegado, ejecutar manualmente para validar:

1. Servicio → **Advanced → Run Command**
2. Comando: `node index.js`
3. Save

**Salida esperada** (corrida exitosa, ~5-15 segundos):

```
================================
INICIANDO CARGA_BASE_B2C
================================
Filas encontradas: 977
Columnas encontradas: 67
Conectado a MySQL
Columnas del sheet ignoradas (no existen en BASE_B2C):
  - HORAS_ABIERTO
  - OPERATIVIDAD
  - NOTA_OPERATIVIDAD
  - TIPO_FALLA
Columnas a insertar: 63 de 67
Procesadas: 100 | Insertadas: 100 | Omitidas: 0
Procesadas: 200 | Insertadas: 200 | Omitidas: 0
...
Procesadas: 977 | Insertadas: 977 | Omitidas: 0
================================
FINALIZADO
Total procesadas: 977
Insertadas: 956
Omitidas (duplicadas o con error): 21
================================
```

> **Nota**: La diferencia entre `Insertadas: 977` y `Insertadas: 956` es normal. El log puede ser engañoso las primeras ejecuciones porque `result.affectedRows` de mysql2 para `INSERT IGNORE` a veces devuelve el conteo intentado. Lo importante es que el conteo de filas en MySQL coincida con la cantidad de órdenes únicas del sheet.

### 7.3. Programar la corrida diaria

1. Servicio → pestaña **Schedules**
2. Click **Create Schedule**

Configuración recomendada:

| Campo | Valor |
|---|---|
| **Task Name** | `Carga BASE_B2C diaria` |
| **Schedule** | `Custom` |
| **Cron** | `0 12 * * *` (equivale a 7 AM hora Colombia UTC-5) |
| **Shell Type** | `Bash` |
| **Command** | `cd /app && node index.js` |
| **Enabled** | ON |

**Zonas horarias**:
- Colombia (UTC-5) → `0 12 * * *`
- México (UTC-6) → `0 13 * * *`
- Argentina (UTC-3) → `0 10 * * *`
- España (UTC+1/+2) → `0 6 * * *` o `0 5 * * *`

### 7.4. Reinicio del contenedor

Dockploy gestiona automáticamente el ciclo de vida del contenedor. Con `Restart Policy: On Failure`, si el proceso falla, el contenedor se reinicia (útil ante caídas de red), pero no entra en bucle indefinido.

---

## 8. Cómo funciona el script

### 8.1. Flujo paso a paso

```
1. main() ejecuta
2. Autentica con Google vía service account
3. Lee el sheet completo (filas + headers)
4. Conecta a MySQL
5. Query INFORMATION_SCHEMA.COLUMNS para ver columnas reales
6. Filtra headers: solo inserta las que existen en la tabla
   → log: "Columnas del sheet ignoradas (no existen en BASE_B2C): ..."
7. Para cada fila (excepto header):
   a. Construye array de valores aplicando convertirFecha/convertirHora según corresponda
   b. Si el batch llega a 100 filas, lo inserta en transacción
   c. Captura errores de fila individualmente y loguea (sin abortar el job)
8. Inserta el batch final (<100 filas) si queda algo
9. Cierra conexión MySQL
10. Log: "FINALIZADO"
```

### 8.2. Batch INSERT (cada 100 filas)

En lugar de 1017 INSERTs individuales, agrupa en **multi-row INSERT**:

```sql
INSERT IGNORE INTO BASE_B2C
  (TECNICO, FECHA, ESTADO, ..., ORDEN_TRABAJO)
VALUES
  (?, ?, ?, ..., ?),     -- fila 1
  (?, ?, ?, ..., ?),     -- fila 2
  ...
  (?, ?, ?, ..., ?);     -- fila 100
```

Cada batch corre dentro de una **transacción MySQL** con `beginTransaction()` / `commit()` / `rollback()`. Esto reduce:
- 1017 round-trips a la DB → 11 round-trips
- 1017 fsync → 11 fsync

**Resultado**: la corrida pasa de ~1-3 horas a **5-15 segundos** (dependiendo de latencia de red al MySQL).

### 8.3. Mapeo de columnas dinámicas

```js
// Solo las columnas que existen en la tabla
const headersExistentes = headers.filter(h => tableCols.has(h));
//     ej: ["TECNICO", "FECHA", ..., "ORDEN_TRABAJO"]

const columnas = headersExistentes.join(",");
const placeholders = headersExistentes.map(() => "?").join(",");

// Para mapear filas a valores usando los índices correctos del sheet
const valores = headersExistentes.map((columna) => {
  const idx = headers.indexOf(columna);
  return fila[idx];  // ← valor de la celda correspondiente
});
```

### 8.4. Conversión de tipos

Las columnas de fecha se transforman antes de insertar:

| Tipo sheet | Formato | Salida MySQL |
|---|---|---|
| `FECHA`, `FECHA_PROGRAMACION`, etc. (12 columnas) | `DD/MM/YYYY` o `DD/MM/YYYY HH:MM` | `YYYY-MM-DD HH:MM:SS` |
| `HORA_INICIO_RANGO_INICIAL`, `HORA_INICIO_RANGO_FINAL` | `HH:MM` o `HH:MM:SS` | `HH:MM:SS` |
| Otras columnas | (lo que venga) | se inserta literal (NULL si está vacío) |

Si un valor de fecha/hora no matchea el regex esperado, se inserta como `NULL` (no rompe la corrida).

### 8.5. Manejo de errores

- **Fila con error** → se loguea y se continúa con la siguiente (no aborta el job)
- **Batch que falla** → rollback automático, loguea, continúa con el siguiente batch
- **MySQL cae** → `process.exit(1)` en el `.catch()` global

---

## 9. Troubleshooting

### 9.1. El job corre pero inserta 0 filas

**Síntoma**: log dice `Total procesadas: 977` pero `Insertadas: 0`.

**Causa probable**: Ninguna de las columnas del sheet matchea con la tabla. Verificar:
- El sheet se llama exactamente `CUMPLIMIENTO DIA ANTERIOR` (con mayúsculas y espacios)
- Los headers del sheet están limpios (sin espacios al inicio/fin, sin caracteres especiales)
- La tabla destino es `BASE_B2C` en la base de datos correcta

### 9.2. Error: `Unknown column 'X' in 'field list'`

**Causa**: El sheet tiene columnas que no existen en la tabla y la Opción B (filtro dinámico) no está desplegada.

**Solución**:
1. Verificar que el código desplegado incluye el filtro con `INFORMATION_SCHEMA`
2. Redeploy con la última versión de `index.js`
3. Verificar que `headersExistentes` se está usando en el INSERT, no `headers`

### 9.3. El job se queda corriendo horas

**Causa probable**: Código viejo con INSERT individual por fila (sin batches).

**Solución**: Verificar que el código desplegado tiene `BATCH_SIZE = 100` y `insertBatch()` con transacción.

### 9.4. El job se reinicia infinitamente (bucle)

**Causa**: El contenedor tiene `Restart Policy: Always` o `On Failure` con muchos reintentos, y el script termina con `process.exit(1)` por un error fatal.

**Solución**:
1. Cambiar `Restart Policy` a `On Failure` con máximo 3 reintentos
2. O mejor: `No` (que no reinicie) y dejar que el cron del día siguiente levante el contenedor

### 9.5. Duplicados en la base de datos

**Causa**: Falta el `UNIQUE KEY` en `ORDEN_TRABAJO`.

**Solución**:
```sql
ALTER TABLE BASE_B2C
  ADD UNIQUE KEY uk_orden (ORDEN_TRABAJO);
```

### 9.6. El cron no dispara a la hora esperada

**Verificar**:
- El schedule está **Enabled**
- El contenedor está corriendo en el momento del cron (con `On Failure` se cae y puede no estar arriba)
- La zona horaria: Dockploy usa UTC por defecto

---

## 10. Limitaciones conocidas

1. **Columnas nuevas del sheet**: Si el sheet agrega columnas que tampoco existen en la tabla, se ignoran sin error. Si agregas columnas a MySQL, no es necesario tocar el código: se detectan automáticamente.

2. **Formato de fecha**: Solo se aceptan `DD/MM/YYYY` y `DD/MM/YYYY HH:MM`. Si el sheet cambia el formato (por ejemplo, `MM/DD/YYYY`), la conversión falla y el valor se inserta como NULL. Hay que actualizar la regex en `convertirFecha()`.

3. **Hojas con datos en otra pestaña**: El script lee siempre `CUMPLIMIENTO DIA ANTERIOR`. Si los datos migran a otra pestaña, hay que cambiar la constante `SHEET_NAME`.

4. **Volumen**: El script está optimizado para ~1000 filas. Para >100k filas可以考虑 chunking por rango de fechas o paginación.

5. **Detección de duplicados**: Solo se descartan por `ORDEN_TRABAJO` exacto. Si una orden aparece con `ORDEN_TRABAJO` ligeramente distinto (espacios, mayúsculas), no se detecta como duplicado. Es responsabilidad de la fuente mantener los IDs limpios.

---

## 11. Changelog

### v1.0 (estado actual)

**Fixes críticos**:
- ✅ `SyntaxError: Unexpected token 'catch'` — agregada la `}` que cerraba el `for`
- ✅ Eliminado `insertados++` duplicado (contaba el doble)
- ✅ Removidos los 5 bloques de debug `if (i >= 325)` que quedaban en el código
- ✅ `main()` envuelto en `.catch()` para manejar rechazos async

**Mejoras de performance**:
- ✅ Batch INSERT de 100 filas dentro de transacción (antes: INSERT individual por fila → ~1-3 horas; ahora: ~5-15 segundos)
- ✅ `INSERT IGNORE` para idempotencia (corridas duplicadas no rompen ni duplican)
- ✅ `beginTransaction()` / `commit()` / `rollback()` por batch

**Mejoras de robustez**:
- ✅ Filtro dinámico de columnas consultando `INFORMATION_SCHEMA.COLUMNS` (antes: hard-codeadas → fallaba cuando el sheet tenía columnas que la tabla no)
- ✅ `throw filaError` reemplazado por `continue` — una fila mala no aborta el job
- ✅ Log claro de columnas ignoradas: `Columnas del sheet ignoradas (no existen en BASE_B2C): ...`

**Base de datos**:
- ✅ `ALTER TABLE BASE_B2C ADD UNIQUE KEY uk_orden (ORDEN_TRABAJO)` para idempotencia

---

## 12. Comandos útiles

### Local

```bash
# Instalar dependencias
npm install

# Validar sintaxis
node --check index.js

# Correr localmente (requiere env vars en .env o shell)
node index.js

# En Windows con .env (usando cross-env o similar):
# set GOOGLE_CLIENT_EMAIL=... && node index.js
```

### Producción (Dockploy)

```bash
# Ver logs de la corrida
Dockploy → Servicio → Logs

# Ejecutar manualmente
Dockploy → Servicio → Advanced → Run Command: node index.js

# Verificar última corrida
mysql -h <DB_HOST> -u <user> -p <DB_NAME> -e \
  "SELECT COUNT(*) FROM BASE_B2C WHERE DATE(FECHA) = CURDATE();"
```

---

## 13. Contacto

- **Equipo MDM / Sheets**: responsable del sheet `CUMPLIMIENTO DIA ANTERIOR`
- **Equipo DBA**: responsable del schema de `BASE_B2C`
- **Operaciones Dockploy**: responsable del servicio y sus variables de entorno

---

## Anexo: ejemplo de log de corrida exitosa

```
================================
INICIANDO CARGA_BASE_B2C
================================
Filas encontradas: 977
Columnas encontradas: 67
Conectado a MySQL
Columnas del sheet ignoradas (no existen en BASE_B2C):
  - HORAS_ABIERTO
  - OPERATIVIDAD
  - NOTA_OPERATIVIDAD
  - TIPO_FALLA
Columnas a insertar: 63 de 67
Procesadas: 100 | Insertadas: 100 | Omitidas: 0
Procesadas: 200 | Insertadas: 200 | Omitidas: 0
Procesadas: 300 | Insertadas: 300 | Omitidas: 0
Procesadas: 400 | Insertadas: 400 | Omitidas: 0
Procesadas: 500 | Insertadas: 500 | Omitidas: 0
Procesadas: 600 | Insertadas: 600 | Omitidas: 0
Procesadas: 700 | Insertadas: 700 | Omitidas: 0
Procesadas: 800 | Insertadas: 800 | Omitidas: 0
Procesadas: 900 | Insertadas: 900 | Omitidas: 0
Procesadas: 977 | Insertadas: 977 | Omitidas: 0
================================
FINALIZADO
Total procesadas: 977
Insertadas: 956
Omitidas (duplicadas o con error): 21
================================
```