import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceDir = "archive";
const outputDir = path.join(sourceDir, "eurocopa");

const euroNations = new Set(
  [
    "Albania",
    "Austria",
    "Belgium",
    "Croatia",
    "Czech Republic",
    "Denmark",
    "England",
    "France",
    "Georgia",
    "Germany",
    "Hungary",
    "Italy",
    "Holland",
    "Netherlands",
    "Poland",
    "Portugal",
    "Romania",
    "Scotland",
    "Serbia",
    "Slovakia",
    "Slovenia",
    "Spain",
    "Switzerland",
    "Turkey",
    "Ukraine",
  ].map(normalizeName),
);

const sourceFiles = [
  "ea_fc26_players.csv",
  "ea_fc26_outfield.csv",
  "ea_fc26_goalkeepers.csv",
];

await mkdir(outputDir, { recursive: true });

for (const fileName of sourceFiles) {
  const inputPath = path.join(sourceDir, fileName);
  const outputPath = path.join(outputDir, fileName.replace(".csv", "_eurocopa.csv"));
  const content = await readFile(inputPath, "utf8");
  const rows = parseCsv(content);

  if (rows.length === 0) {
    await writeFile(outputPath, "", "utf8");
    continue;
  }

  const header = rows[0];
  const nationalityIndex = header.indexOf("nationality");

  if (nationalityIndex === -1) {
    throw new Error(`${fileName} does not contain a nationality column.`);
  }

  const filteredRows = rows
    .slice(1)
    .filter((row) => euroNations.has(normalizeName(row[nationalityIndex] ?? "")));

  await writeFile(outputPath, stringifyCsv([header, ...filteredRows]), "utf8");
  console.log(`${fileName}: ${filteredRows.length} players -> ${outputPath}`);
}

function normalizeName(value) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows;
}

function stringifyCsv(rows) {
  return `${rows
    .map((row) =>
      row
        .map((field) => {
          const value = field ?? "";
          return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
        })
        .join(","),
    )
    .join("\n")}\n`;
}
