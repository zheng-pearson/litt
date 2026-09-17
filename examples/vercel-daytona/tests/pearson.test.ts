import {test,expect,beforeAll,afterAll,beforeEach} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
import {readConfig} from '../src/config.js';
import {createApp} from '../src/app.js';
import {schemaSql} from '../src/schema.js';
import {Store,type Database,type Tenant} from '../src/store.js';
import {Vault} from '../src/security.js';
import {Worker} from '../src/worker.js';
import type {Runtime} from '../src/runtime.js';
import {connectionToken} from '../src/connections.js';
import {startPearsonConnection} from '../src/pearson.js';
const pg=new PGlite();
const adapt=(client:Pick<PGlite,'query'|'transaction'>):Database=>({async query<T>(sql:string,args:unknown[]=[]){return(await client.query<T>(sql,args)).rows;},async transaction<T>(fn:(db:Database)=>Promise<T>){return client.transaction(tx=>fn(adapt(tx as unknown as PGlite)));}});
const config=readConfig({PUBLIC_BASE_URL:'https://second.example.com',PEARSON_MCP_URL:'https://pearson.example.com/api/second/mcp',DATABASE_URL:'postgresql://unused',ENCRYPTION_KEY:'ab'.repeat(32),CRON_SECRET:'c'.repeat(32),TELEGRAM_BOT_TOKEN:'t'.repeat(32),TELEGRAM_WEBHOOK_SECRET:'s'.repeat(32),DAYTONA_API_KEY:'test-only',DAYTONA_SNAPSHOT:'test',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',ALLOWED_EMAILS:'user@example.com',OPENAI_API_KEY:'test',OAUTH_AUTOMATIC_RESUME:'true'});
const store=new Store(adapt(pg),new Vault(config.ENCRYPTION_KEY));
let tenant:Tenant;
let calls:string[]=[];
let background:Promise<void>[]=[];
let messages:string[]=[];
let authUrl:string;
let exchangeStatus='complete';
let existing:unknown[]=[];
const runtime:Runtime={async provision(){},async request(_tenant,path){calls.push(path);if(path==='/v1/internal/mcp/list'){return Response.json({servers:existing});}if(path==='/v1/internal/mcp/auth/start'){return Response.json({auth_url:authUrl,state:'pearson'});}if(path==='/v1/internal/mcp/auth/status/pearson'){return Response.json({status:exchangeStatus});}return Response.json({ok:true});}};
const worker=new Worker(config,store,runtime,async(_id,text)=>{messages.push(text);});
const app=createApp(config,store,runtime,worker,p=>background.push(p));
beforeAll(async()=>{await pg.exec(schemaSql);});
afterAll(async()=>{await pg.close();});
beforeEach(async()=>{
 await pg.exec('DELETE FROM demo_jobs; DELETE FROM demo_tickets; DELETE FROM demo_tenants;');
 tenant=await store.ensureTenant('test-chat');await pg.query("UPDATE demo_tenants SET status='active' WHERE id=$1",[tenant.id]);tenant=await store.tenant(tenant.id);
 calls=[];messages=[];background=[];exchangeStatus='complete';existing=[];
 const url=new URL('https://pearson.example.com/second/authorize');url.search=new URLSearchParams({client_id:'second',redirect_uri:config.PUBLIC_BASE_URL+'/webhooks/oauth/callback',resource:config.PEARSON_MCP_URL!,code_challenge_method:'S256',state:'state-'.repeat(8)}).toString();authUrl=url.href;
});
async function start(){
 const link=await app(new Request(config.PUBLIC_BASE_URL+'/integrations/connect',{method:'POST',headers:{Authorization:'Bearer '+connectionToken(config,tenant.id),'Content-Type':'application/json'},body:JSON.stringify({provider:'pearson',conversationId:'conversation-123'})}));expect(link.status).toBe(200);
 const {url}=await link.json();
 const page=await app(new Request(url));expect(await page.text()).toContain('Continue with Pearson');expect(calls).toHaveLength(0);
 const started=await app(new Request(url,{method:'POST',headers:{Origin:config.PUBLIC_BASE_URL}}));expect(started.status).toBe(303);
 return {started,url,cookie:started.headers.get('set-cookie')!.split(';')[0],state:new URL(started.headers.get('location')!).searchParams.get('state')!};
}
test('chat link starts native MCP OAuth without requiring Google connection',async()=>{
 const {started,state,url}=await start();expect(started.headers.get('location')).toBe(authUrl);expect(state).not.toBe('pearson');expect(calls).toContain('/v1/internal/mcp/add');
 expect((await app(new Request(url,{method:'POST',headers:{Origin:config.PUBLIC_BASE_URL}}))).status).toBe(400);
});
test('callback is browser-bound, single-use, verified and resumes the original conversation',async()=>{
 const {state,cookie}=await start();const url=config.PUBLIC_BASE_URL+'/webhooks/oauth/callback?state='+state+'&code=example-code';
 expect((await app(new Request(url))).status).toBe(403);
 const success=await app(new Request(url,{headers:{Cookie:cookie}}));expect(success.status).toBe(200);await Promise.all(background);
 expect(calls).toContain('/v1/internal/mcp/auth/status/pearson');expect(calls).toContain('/v1/messages');expect(messages.some(m=>m.includes('Pearson'))).toBe(true);
 expect((await app(new Request(url,{headers:{Cookie:cookie}}))).status).toBe(400);
});
test('denial and failed exchanges never enqueue successful continuation',async()=>{
 const {state,cookie}=await start();exchangeStatus='error';
 const result=await app(new Request(config.PUBLIC_BASE_URL+'/webhooks/oauth/callback?state='+state+'&code=bad',{headers:{Cookie:cookie}}));expect(await result.text()).toContain('Connection unsuccessful');await Promise.all(background);expect(calls).not.toContain('/v1/messages');expect(messages).toHaveLength(0);
});
test('rejects forged auth destinations and mismatched callbacks',async()=>{
 authUrl=authUrl.replace('https://pearson.example.com','https://evil.example.com');await expect(startPearsonConnection(config,tenant,runtime)).rejects.toThrow('Unexpected Pearson');
});
test('does not overwrite another connection sharing the server name',async()=>{
 existing=[{id:'pearson',transport:{type:'streamable-http',url:'https://other.example.com/mcp'}}];await expect(startPearsonConnection(config,tenant,runtime)).rejects.toThrow('incompatible');expect(calls).not.toContain('/v1/internal/mcp/add');
});
test('link issuance requires the tenant capability and an enabled integration',async()=>{
 const req=new Request(config.PUBLIC_BASE_URL+'/integrations/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'pearson'})});expect((await app(req)).status).toBe(401);
});
