import { execFileSync } from "node:child_process";
const sf = JSON.parse(execFileSync("sf", ["org", "display", "--target-org", "jaygentforce", "--json"], { encoding: "utf8" }));
const { accessToken, instanceUrl, apiVersion } = sf.result;
const base = `${instanceUrl}/services/data/v${apiVersion}`;
const auth = { Authorization: `Bearer ${accessToken}` };
const r = await fetch(`${base}/ssot/data-streams/enginedatacsv_cdp_data_javier?includeMappings=true`, { headers: auth }).then(r=>r.json());
// Print every key that looks like a type/connector hint
console.log("dataStreamType:", r.dataStreamType);
console.log("dataAccessMode:", r.dataAccessMode);
console.log("connectorInfo:", JSON.stringify(r.connectorInfo, null, 2));
console.log("advancedAttributes:", JSON.stringify(r.advancedAttributes, null, 2));
