import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { swaggerSpec } from "../src/config/swagger.js";

const sortObject = (value) => {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
};
const output = resolve(process.cwd(), process.argv[2] || "openapi/sanfaani-api.v1.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(sortObject(swaggerSpec), null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
