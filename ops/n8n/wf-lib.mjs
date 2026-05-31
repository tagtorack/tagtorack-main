// ops/n8n/wf-lib.mjs — shared n8n workflow-builder helpers (n8n 1.74.1).
export const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };

export const webhookNode = (id, name, path, x = -200) => ({
  parameters: { httpMethod: "POST", path, responseMode: "responseNode", options: {} },
  id, name, type: "n8n-nodes-base.webhook", typeVersion: 2, position: [x, 0], webhookId: path.replace(/\//g, "-") + "-wh",
});
export const codeNode = (id, name, jsCode, x) => ({
  parameters: { jsCode }, id, name, type: "n8n-nodes-base.code", typeVersion: 2, position: [x, 0],
});
export const pgNode = (id, name, query, queryReplacement, x) => ({
  parameters: { operation: "executeQuery", query, options: { queryReplacement } },
  id, name, type: "n8n-nodes-base.postgres", typeVersion: 2.5, position: [x, 0],
  credentials: { postgres: PG_CRED }, alwaysOutputData: true,
});
export const respondNode = (id, name, x) => ({
  parameters: { respondWith: "json", responseBody: "={{ $json.body }}", options: { responseCode: "={{ $json.statusCode }}" } },
  id, name, type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [x, 0],
});
// Linear connections from an ordered node-name list.
export const linearConnections = (names) => {
  const c = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], type: "main", index: 0 }]] };
  return c;
};
// R2 SigV4 GET presign — Code-node snippet (require('crypto')); reused by queue.
// Returns a JS source string defining `presignGet(r2key, expiresSec)`.
export const r2PresignSnippet = () => `
function presignGet(r2key, expiresSec) {
  const crypto = require('crypto');
  const acct=$env.R2_ACCOUNT_ID, ak=$env.R2_ACCESS_KEY_ID, sk=$env.R2_SECRET_ACCESS_KEY, bucket=$env.R2_BUCKET;
  const host = acct + '.r2.cloudflarestorage.com';
  const amzDate = new Date().toISOString().replace(/[-:]|\\.\\d{3}/g,'');
  const day = amzDate.slice(0,8);
  const scope = day + '/auto/s3/aws4_request';
  const enc = (s)=>encodeURIComponent(s).replace(/[!'()*]/g,(c)=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  const sha = (s)=>crypto.createHash('sha256').update(s).digest('hex');
  const hmac = (k,m)=>crypto.createHmac('sha256',k).update(m).digest();
  const uri = '/'+enc(bucket)+'/'+r2key.split('/').map(enc).join('/');
  const q = { 'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':ak+'/'+scope,'X-Amz-Date':amzDate,'X-Amz-Expires':String(expiresSec),'X-Amz-SignedHeaders':'host' };
  const qs = Object.keys(q).sort().map(k=>enc(k)+'='+enc(q[k])).join('&');
  const creq = ['GET',uri,qs,'host:'+host+'\\n','host','UNSIGNED-PAYLOAD'].join('\\n');
  const sts = ['AWS4-HMAC-SHA256',amzDate,scope,sha(creq)].join('\\n');
  let k=hmac('AWS4'+sk,day); k=hmac(k,'auto'); k=hmac(k,'s3'); k=hmac(k,'aws4_request');
  return 'https://'+host+uri+'?'+qs+'&X-Amz-Signature='+hmac(k,sts).toString('hex');
}`;
