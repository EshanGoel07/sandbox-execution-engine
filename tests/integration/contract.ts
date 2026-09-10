/**
 * Contract checks: validate live API responses against the schemas in
 * openapi.yaml. This is what makes the spec the source of truth rather than a
 * description that drifts — every response schema is `additionalProperties:
 * false`, so a field the server returns but the spec doesn't declare (a
 * leaked column, say) fails the build just like a missing one.
 *
 * OpenAPI 3.1 schemas are JSON Schema 2020-12, so a standard validator works;
 * refs are rewritten from `#/components/schemas/X` to `#/$defs/X` so the
 * component schemas can be loaded as one ordinary schema document.
 */
import { readFileSync } from "fs";
import { join } from "path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const SPEC_PATH = join(__dirname, "..", "..", "openapi.yaml");
const DOC_ID = "https://virtual-judge.local/openapi.json";

const spec = parse(readFileSync(SPEC_PATH, "utf8"));
const schemas = JSON.parse(
  JSON.stringify(spec.components.schemas).replaceAll("#/components/schemas/", "#/$defs/")
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ $id: DOC_ID, $defs: schemas });

const validators = new Map<string, ReturnType<typeof ajv.compile>>();

/** null if `body` matches components.schemas[name], otherwise a readable list of violations. */
export function contractViolation(name: string, body: unknown): string | null {
  if (!(name in schemas)) throw new Error(`openapi.yaml has no schema named ${name}`);
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `${DOC_ID}#/$defs/${name}` });
    validators.set(name, validate);
  }
  if (validate(body)) return null;
  return ajv.errorsText(validate.errors, { dataVar: name });
}
