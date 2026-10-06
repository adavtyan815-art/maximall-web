import fs from 'fs';
import path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const dir = path.join(__dirname, '..', '..', 'contracts');
const load = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));

export const schemas = {
  envelope: load('envelope.schema.json'),
  commands: load('commands.schema.json'),
  card: load('card.schema.json'),
  mapping: load('catalog-mapping.schema.json'),
  socket: load('socket-events.schema.json'),
  render: load('render-api.schema.json'),
  dossier: load('dossier-api.schema.json'),
};

export const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const s of Object.values(schemas)) ajv.addSchema(s);

// Derived schemas: the x- sections of commands/socket-events are not traversed by Ajv, so their sub-schemas are
// re-homed under $defs of schemas with ids in the same base (relative refs keep resolving).
const cmdArgs: any = { $id: "maximall/ai/_command_args.json", $defs: { ...schemas.commands.$defs } };
for (const [k, v] of Object.entries<any>(schemas.commands["x-commands"])) cmdArgs.$defs["args_" + k] = v.args;
const sockDefs: any = { $id: "maximall/ai/_socket_events.json", $defs: {} };
for (const dir of ["x-server-to-client", "x-client-to-server"]) for (const [k, v] of Object.entries<any>(schemas.socket[dir])) sockDefs.$defs[dir + "_" + k] = v;
ajv.addSchema(cmdArgs);
ajv.addSchema(sockDefs);

export function validator(ref: string) {
  const v = ajv.getSchema(ref);
  if (!v) throw new Error(`no schema ${ref}`);
  return v;
}

/** Validate a payload against x-server-to-client / x-client-to-server event schemas of socket-events.schema.json. */
export function socketEventValidator(direction: "x-server-to-client" | "x-client-to-server", event: string) {
  return validator(`maximall/ai/_socket_events.json#/$defs/${direction}_${event}`);
}

export function commandArgsValidator(cmd: string) {
  return validator(`maximall/ai/_command_args.json#/$defs/args_${cmd}`);
}

export function expectValid(v: any, data: any) {
  const ok = v(data);
  if (!ok) throw new Error(`schema validation failed: ${JSON.stringify(v.errors, null, 1)}\n${JSON.stringify(data).slice(0, 800)}`);
}
