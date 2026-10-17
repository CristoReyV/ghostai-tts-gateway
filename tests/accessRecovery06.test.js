"use strict";
const db = require("../netlify/functions/lib/db");
const service = require("../netlify/functions/lib/memberService");
const { prepareMemberDelivery, renderMemberDeliveryForSend } = require("../netlify/functions/lib/memberDelivery");
const { authenticateGhostAIRequest } = require("../netlify/functions/lib/auth");
const { renderGhostAIMemberInvitationEmail } = require("../netlify/functions/lib/emailTemplates");
const { buildAdminSessionCookie } = require("../netlify/functions/lib/adminAuth");
beforeEach(() => {
 process.env.GHOSTAI_ADMIN_AUTH_TOKEN = "recovery-test-admin";
 process.env.GHOSTAI_TOKEN_HASH_PEPPER = "recovery-test-pepper";
 db._setMemoryStoreEnabled(true);db._resetMemoryStore();
});
afterAll(() => db._setMemoryStoreEnabled(false));
const auth = key => authenticateGhostAIRequest({headers:{authorization:`Bearer ${key}`}});
test("server and OWNER-authorized OPERATOR preview contain key before CTA, without persisting plaintext", async () => {
 const {member} = await service.createMemberWithAccess({name:"QA Recovery",email:"qa@example.test",accessPlan:"annual"});
 const sent = await renderMemberDeliveryForSend(member.id);
 const fullKey = service.safeDecryptKey((await db.getLatestActivationTokenForMember(member.id)).encrypted_key);
 expect(sent.html.includes(fullKey)).toBe(true);
 expect(sent.text.includes(fullKey)).toBe(true);
 expect(sent.html.indexOf(fullKey) < sent.html.indexOf("ACTIVAR Y ENTRAR A GHOSTAI")).toBe(true);
 expect(sent.subject.includes(fullKey)||sent.preheader.includes(fullKey)).toBe(false);
 const operator = await db.createAdminUserRecord({name:"QA Operator",role:"operator",status:"active"});
 const cookie = buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN,operator).split(";")[0];
 for(const endpoint of ["admin-members-prepare-email","admin-members-email-preview"]){
  const res = await require(`../netlify/functions/${endpoint}`).handler({httpMethod:"POST",headers:{cookie},body:JSON.stringify({memberId:member.id})});
  expect(res.statusCode).toBe(200);expect(res.body.includes(fullKey)).toBe(true);
  expect(JSON.parse(res.body).preview.keyRedacted).toBe(false);
  expect(res.body.includes("gai_act_")).toBe(true);
  const blocked = await require(`../netlify/functions/${endpoint}`).handler({httpMethod:"POST",headers:{},body:JSON.stringify({memberId:member.id})});
  expect(blocked.statusCode).toBe(401);expect(blocked.body.includes(fullKey)).toBe(false);
 }
 expect((await db.getMemberById(member.id)).last_email_sent_at).toBeFalsy();
});
test("active rotation replaces only key, retains dates, revokes old key and sends replacement link", async () => {
 const created=await service.createMemberWithAccess({name:"QA Active",email:"qa@example.test",accessPlan:"monthly"});
 const activated=await service.activateMemberAccess(created.activationToken);
 const before=await db.getMemberById(created.member.id);
 expect((await auth(activated.accessKey)).ok).toBe(true);
 const replacement=await service.regenerateMemberKey(before.id);
 const after=await db.getMemberById(before.id);
 expect([after.id,after.status,after.access_plan,after.activated_at,after.expires_at]).toEqual([before.id,before.status,before.access_plan,before.activated_at,before.expires_at]);
 expect(after.key_id===before.key_id).toBe(false);
 expect((await auth(activated.accessKey)).ok).toBe(false);
 const newKey=service.safeDecryptKey((await db.getLatestActivationTokenForMember(before.id)).encrypted_key);
 expect((await auth(newKey)).ok).toBe(true);
 const rendered=await renderMemberDeliveryForSend(before.id);
 expect(rendered.html.includes(newKey)).toBe(true);
 expect(rendered.text).toContain("Tu llave anterior dejó de funcionar");
 expect(rendered.text).toContain("ABRIR GHOSTAI");
 expect(rendered.text).not.toContain("?activate=");
 expect(after.last_email_status).toBe("not_sent");
 expect(replacement.activationToken).toBeNull();
});
test("consumed link stays single use; escrow retained encrypted for resend and no period reset",async()=>{
 const created=await service.createMemberWithAccess({name:"QA",email:"qa@example.test",accessPlan:"monthly"});
 const results=await Promise.allSettled([service.activateMemberAccess(created.activationToken),service.activateMemberAccess(created.activationToken)]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 const escrow=await db.getLatestActivationTokenForMember(created.member.id);
 expect(escrow.status).toBe("consumed");expect(escrow.encrypted_key.startsWith("v1")).toBe(true);
 const before=await db.getMemberById(created.member.id);
 await expect(service.activateMemberAccess(created.activationToken)).rejects.toMatchObject({code:"TOKEN_ALREADY_USED"});
 const after=await db.getMemberById(created.member.id);
 expect(after.activated_at).toBe(before.activated_at);expect(after.expires_at).toBe(before.expires_at);
 const delivery=await renderMemberDeliveryForSend(created.member.id);expect(delivery.html.includes("gai_live_")).toBe(true);
});
test("template escapes key and member fields without JavaScript",()=>{
 const rendered=renderGhostAIMemberInvitationEmail({name:"<script>bad</script>",plan:"annual",activationLink:"https://example.test",accessKey:"gai_live_<tag>.secret"});
 expect(rendered.html).not.toContain("<script>");expect(rendered.html).toContain("gai_live_&lt;tag&gt;");
 expect(rendered.html).toContain("font-family:monospace");
});
