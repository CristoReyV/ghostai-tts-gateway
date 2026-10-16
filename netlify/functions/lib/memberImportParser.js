/**
 * @file memberImportParser.js
 * High-performance parser and validator for Member bulk imports (.xlsx and .csv).
 * Supports case-insensitive headers, flexible column names, duplicate detection,
 * and comprehensive row validation without destructive data mutation.
 */

"use strict";

const JSZip = require("jszip");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalizes string keys for header matching.
 * @param {string} str
 * @returns {string}
 */
function normalizeHeader(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Normalizes access plan string to 'monthly' or 'annual'.
 * Accepts Mensual, Anual, Monthly, Annual, etc.
 * @param {string} val
 * @returns {"monthly" | "annual" | null}
 */
function normalizePlan(val) {
  if (!val || typeof val !== "string") return null;
  const clean = val.toLowerCase().trim();
  if (clean === "mensual" || clean === "monthly" || clean === "mes" || clean === "1 mes") {
    return "monthly";
  }
  if (clean === "anual" || clean === "annual" || clean === "ano" || clean === "año" || clean === "1 ano" || clean === "1 año") {
    return "annual";
  }
  return null;
}

/**
 * Parses a single CSV line according to RFC 4180 rules.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsvRows(text) {
  const rows = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  // Auto-detect delimiter: comma, semicolon, or tab
  let delimiter = ",";
  const firstLine = text.split(/\r\n|\n|\r/)[0] || "";
  if (!firstLine.includes(",") && firstLine.includes(";")) {
    delimiter = ";";
  } else if (!firstLine.includes(",") && firstLine.includes("\t")) {
    delimiter = "\t";
  }

  while (i < text.length) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === delimiter) {
        currentRow.push(currentField.trim());
        currentField = "";
        i++;
        continue;
      } else if (char === "\r") {
        if (nextChar === "\n") i++;
        currentRow.push(currentField.trim());
        if (currentRow.some((c) => c.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = "";
        i++;
        continue;
      } else if (char === "\n") {
        currentRow.push(currentField.trim());
        if (currentRow.some((c) => c.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = "";
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((c) => c.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Maps raw matrix rows into typed member objects based on header matching.
 * @param {string[][]} rawGrid
 * @returns {Array<{ name: string, email: string, accessPlan: "monthly" | "annual" | null, rawPlan: string }>}
 */
function mapGridToMembers(rawGrid) {
  if (!rawGrid || rawGrid.length < 2) return [];

  const headers = rawGrid[0];
  let nameIdx = -1;
  let emailIdx = -1;
  let planIdx = -1;

  for (let idx = 0; idx < headers.length; idx++) {
    const h = normalizeHeader(headers[idx]);
    if (nameIdx === -1 && (h === "nombre" || h === "name" || h === "fullname" || h === "usuario")) {
      nameIdx = idx;
    } else if (emailIdx === -1 && (h === "correo" || h === "email" || h === "mail" || h === "correoelectronico")) {
      emailIdx = idx;
    } else if (planIdx === -1 && (h === "tipodeacceso" || h === "acceso" || h === "plan" || h === "accessplan" || h === "tipo")) {
      planIdx = idx;
    }
  }

  // Fallback defaults if headers could not be found by name: col 0 = name, col 1 = email, col 2 = plan
  if (nameIdx === -1) nameIdx = 0;
  if (emailIdx === -1) emailIdx = 1;
  if (planIdx === -1) planIdx = 2;

  const dataRows = rawGrid.slice(1);
  const results = [];

  for (const row of dataRows) {
    // Ignore completely empty rows
    if (!row || !row.some((val) => val && val.trim().length > 0)) {
      continue;
    }

    const name = row[nameIdx] !== undefined ? row[nameIdx].trim() : "";
    const email = row[emailIdx] !== undefined ? row[emailIdx].trim() : "";
    const rawPlan = row[planIdx] !== undefined ? row[planIdx].trim() : "";
    const plan = normalizePlan(rawPlan);

    results.push({
      name,
      email,
      accessPlan: plan,
      rawPlan,
    });
  }

  return results;
}

/**
 * Parses raw CSV string or Buffer into member objects.
 * @param {string | Buffer} input
 * @returns {Array<{ name: string, email: string, accessPlan: "monthly" | "annual" | null, rawPlan: string }>}
 */
function parseCsv(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  const grid = parseCsvRows(text);
  return mapGridToMembers(grid);
}

/**
 * Parses raw XLSX Buffer using JSZip.
 * Extracts sheet1.xml and sharedStrings.xml.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 * @returns {Promise<Array<{ name: string, email: string, accessPlan: "monthly" | "annual" | null, rawPlan: string }>>}
 */
async function parseXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  // 1. Parse shared strings if present
  const sharedStrings = [];
  const sstFile = zip.file("xl/sharedStrings.xml") || zip.file("xl/SharedStrings.xml");
  if (sstFile) {
    const sstXml = await sstFile.async("string");
    // Extract each <si> ... </si> block
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
    let match;
    while ((match = siRegex.exec(sstXml)) !== null) {
      const siContent = match[1];
      // Extract all <t> tags inside this <si>
      const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
      let textPieces = [];
      let tMatch;
      while ((tMatch = tRegex.exec(siContent)) !== null) {
        textPieces.push(tMatch[1]);
      }
      sharedStrings.push(
        textPieces
          .join("")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      );
    }
  }

  // 2. Locate sheet1
  let sheetFile =
    zip.file("xl/worksheets/sheet1.xml") ||
    zip.file("xl/worksheets/Sheet1.xml") ||
    Object.values(zip.files).find((f) => f.name.startsWith("xl/worksheets/sheet") && f.name.endsWith(".xml"));

  if (!sheetFile) {
    throw new Error("No se encontró ninguna hoja de cálculo válida en el archivo .xlsx.");
  }

  const sheetXml = await sheetFile.async("string");

  // Helper to convert Excel cell ref (e.g. 'A1', 'C4') to zero-based col index
  function colRefToIdx(ref) {
    const colLetters = ref.replace(/[0-9]/g, "").toUpperCase();
    let col = 0;
    for (let c = 0; c < colLetters.length; c++) {
      col = col * 26 + (colLetters.charCodeAt(c) - 64);
    }
    return col - 1;
  }

  // 3. Parse <row> elements
  const grid = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowXml = rowMatch[1];
    const rowCells = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
      const cellAttrs = cellMatch[1];
      const cellContent = cellMatch[2];

      const rMatch = cellAttrs.match(/\br="([A-Z0-9]+)"/i);
      const cellRef = rMatch ? rMatch[1] : null;
      const colIdx = cellRef ? colRefToIdx(cellRef) : rowCells.length;

      const tMatch = cellAttrs.match(/\bt="([a-z]+)"/i);
      const cellType = tMatch ? tMatch[1] : null;

      let val = "";
      if (cellType === "s") {
        // Shared string index
        const vMatch = cellContent.match(/<v>([0-9]+)<\/v>/i);
        if (vMatch) {
          const sIdx = parseInt(vMatch[1], 10);
          val = sharedStrings[sIdx] || "";
        }
      } else if (cellType === "inlineStr" || cellContent.includes("<is>")) {
        const tTagMatch = cellContent.match(/<t\b[^>]*>([\s\S]*?)<\/t>/i);
        if (tTagMatch) val = tTagMatch[1];
      } else {
        const vMatch = cellContent.match(/<v>([\s\S]*?)<\/v>/i);
        if (vMatch) {
          val = vMatch[1];
        }
      }

      // XML unescape
      val = val
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .trim();

      rowCells[colIdx] = val;
    }

    // Fill sparse indices with empty strings
    for (let idx = 0; idx < rowCells.length; idx++) {
      if (rowCells[idx] === undefined) rowCells[idx] = "";
    }

    if (rowCells.some((c) => c && c.length > 0)) {
      grid.push(rowCells);
    }
  }

  return mapGridToMembers(grid);
}

/**
 * Validates member rows before creation according to Section 5 & 6.
 *
 * Checks:
 *  - invalid email (format)
 *  - incomplete row (missing name, email, or plan)
 *  - unknown access plan
 *  - duplicate email in file
 *  - email already exists in system
 *
 * @param {Array<{ name: string, email: string, accessPlan: "monthly" | "annual" | null, rawPlan: string }>} rows
 * @param {Array<{ email: string, status?: string }>} [existingMembers=[]]
 * @returns {{
 *   total: number,
 *   validCount: number,
 *   existingCount: number,
 *   errorCount: number,
 *   monthlyCount: number,
 *   annualCount: number,
 *   rows: Array<{
 *     rowNumber: number,
 *     name: string,
 *     email: string,
 *     accessPlan: "monthly" | "annual" | null,
 *     planLabel: string,
 *     validationStatus: "Válido" | "YA EXISTE" | "Correo inválido" | "Fila incompleta" | "Tipo de acceso desconocido" | "Duplicado en archivo",
 *     isValid: boolean,
 *     isExisting: boolean,
 *     errorMessage: string | null,
 *     existingMemberStatus: string | null
 *   }>
 * }}
 */
function validateMemberRows(rows, existingMembers = []) {
  const existingMap = new Map();
  for (const em of existingMembers) {
    if (em && em.email) {
      existingMap.set(em.email.toLowerCase().trim(), em.status || "active");
    }
  }

  const seenEmailsInFile = new Set();
  const validatedRows = [];

  let validCount = 0;
  let existingCount = 0;
  let errorCount = 0;
  let monthlyCount = 0;
  let annualCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 1;
    const name = (r.name || "").trim();
    const email = (r.email || "").trim();
    const plan = r.accessPlan;
    const planLabel = plan === "annual" ? "Anual" : plan === "monthly" ? "Mensual" : r.rawPlan || "Desconocido";

    let validationStatus = "Válido";
    let isValid = false;
    let isExisting = false;
    let errorMessage = null;
    let existingMemberStatus = null;

    // 1. Incomplete row check
    if (!name || !email || !r.rawPlan) {
      validationStatus = "Fila incompleta";
      errorMessage = "Faltan campos obligatorios (nombre, correo o plan).";
      errorCount++;
    }
    // 2. Email format check
    else if (!EMAIL_REGEX.test(email)) {
      validationStatus = "Correo inválido";
      errorMessage = "El formato del correo electrónico es inválido.";
      errorCount++;
    }
    // 3. Plan validity check
    else if (!plan) {
      validationStatus = "Tipo de acceso desconocido";
      errorMessage = `Tipo de acceso '${r.rawPlan}' no reconocido. Debe ser Mensual o Anual.`;
      errorCount++;
    }
    // 4. Duplicate in file check
    else if (seenEmailsInFile.has(email.toLowerCase())) {
      validationStatus = "Duplicado en archivo";
      errorMessage = "Este correo se repite más de una vez dentro del mismo archivo.";
      errorCount++;
    }
    // 5. Already exists in system check
    else if (existingMap.has(email.toLowerCase())) {
      validationStatus = "YA EXISTE";
      isExisting = true;
      existingMemberStatus = existingMap.get(email.toLowerCase());
      errorMessage = `El usuario ya existe en el sistema con estado '${existingMemberStatus}'. No se duplicará.`;
      existingCount++;
      seenEmailsInFile.add(email.toLowerCase());
    }
    // 6. Valid row
    else {
      validationStatus = "Válido";
      isValid = true;
      validCount++;
      if (plan === "monthly") monthlyCount++;
      if (plan === "annual") annualCount++;
      seenEmailsInFile.add(email.toLowerCase());
    }

    validatedRows.push({
      rowNumber: rowNum,
      name,
      email,
      accessPlan: plan,
      planLabel,
      validationStatus,
      isValid,
      isExisting,
      errorMessage,
      existingMemberStatus,
    });
  }

  return {
    total: rows.length,
    validCount,
    existingCount,
    errorCount,
    monthlyCount,
    annualCount,
    rows: validatedRows,
  };
}

/**
 * Returns standard CSV text for the 12 official members list.
 * @returns {string}
 */
function get12MembersCsvText() {
  return [
    "NOMBRE,CORREO,Tipo de Acceso",
    "Jose Varela,jjvarela0321@gmail.com,Mensual",
    "Arturo Fuentes,arturo.fuentesg@gmail.com,Mensual",
    "Diana Sandra Cordero Hernandez,sandycordero339@gmail.com,Mensual",
    "Felix Torres,felotorquin@gmail.com,Mensual",
    "Octavio Soperanes,soperanestavo93@gmail.com,Mensual",
    "Freddy Perez,marketingcpa2025@gmail.com,Mensual",
    "Joshua Marquez,joshua.marquez@gmail.com,Mensual",
    "Daniel Avila,danielfelipeparra07@gmail.com,Mensual",
    "Cesar Castro,ingenierocesarcastro@gmail.com,Mensual",
    "Ricardo Daniel Tovar Barrera,r.tovar.barrera@gmail.com,Anual",
    "Sandy Leon,Sandy22karina22@gmail.com,Anual",
    "Jorge MV,jorgr.mv@gmail.com,Mensual",
  ].join("\r\n");
}

/**
 * Builds an official 12-member XLSX Buffer for testing / downloads.
 * @returns {Promise<Buffer>}
 */
async function build12MembersXlsxBuffer() {
  const zip = new JSZip();

  const members = [
    ["NOMBRE", "CORREO", "Tipo de Acceso"],
    ["Jose Varela", "jjvarela0321@gmail.com", "Mensual"],
    ["Arturo Fuentes", "arturo.fuentesg@gmail.com", "Mensual"],
    ["Diana Sandra Cordero Hernandez", "sandycordero339@gmail.com", "Mensual"],
    ["Felix Torres", "felotorquin@gmail.com", "Mensual"],
    ["Octavio Soperanes", "soperanestavo93@gmail.com", "Mensual"],
    ["Freddy Perez", "marketingcpa2025@gmail.com", "Mensual"],
    ["Joshua Marquez", "joshua.marquez@gmail.com", "Mensual"],
    ["Daniel Avila", "danielfelipeparra07@gmail.com", "Mensual"],
    ["Cesar Castro", "ingenierocesarcastro@gmail.com", "Mensual"],
    ["Ricardo Daniel Tovar Barrera", "r.tovar.barrera@gmail.com", "Anual"],
    ["Sandy Leon", "Sandy22karina22@gmail.com", "Anual"],
    ["Jorge MV", "jorgr.mv@gmail.com", "Mensual"],
  ];

  // Collect shared strings
  const sharedStrings = [];
  const sstIndexMap = new Map();
  function getSstId(text) {
    if (sstIndexMap.has(text)) return sstIndexMap.get(text);
    const id = sharedStrings.length;
    sharedStrings.push(text);
    sstIndexMap.set(text, id);
    return id;
  }

  const colLetters = ["A", "B", "C"];
  let rowsXml = "";
  for (let r = 0; r < members.length; r++) {
    const rowNum = r + 1;
    let cXml = "";
    for (let c = 0; c < 3; c++) {
      const val = members[r][c];
      const sId = getSstId(val);
      cXml += `<c r="${colLetters[c]}${rowNum}" t="s"><v>${sId}</v></c>`;
    }
    rowsXml += `<row r="${rowNum}">${cXml}</row>`;
  }

  // [Content_Types].xml
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`
  );

  // _rels/.rels
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );

  // xl/_rels/workbook.xml.rels
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`
  );

  // xl/workbook.xml
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`
  );

  // xl/sharedStrings.xml
  let sstItemsXml = sharedStrings.map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</t></si>`).join("");
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
  ${sstItemsXml}
</sst>`
  );

  // xl/worksheets/sheet1.xml
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${rowsXml}
  </sheetData>
</worksheet>`
  );

  return await zip.generateAsync({ type: "nodebuffer" });
}

module.exports = {
  parseCsv,
  parseXlsx,
  validateMemberRows,
  normalizePlan,
  get12MembersCsvText,
  build12MembersXlsxBuffer,
};
