import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createUser, db } from "./db";
import * as core from "./private-core";
import { getPrivateMemory, getPrivateMemoryReplySnapshot, updatePrivateMemorySettings, syncPrivateMemoryFromNotes,
 correctPrivateMemoryItem, forgetPrivateMemoryItem } from "./private-memory";
function setup() {
 const user=createUser(`${randomUUID()}@boundary.test`,"合成边界用户","hash","salt",false);
 const conv=core.createConversation(user.id);
 const source=core.addUserMessage(user.id,conv.id,"我希望安排变化时提前通知。我喜欢做面包。");
 if(!source) throw Error("source unavailable");
 db.prepare("UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?").run(conv.id);
 updatePrivateMemorySettings(user.id,true,1);
 return {user,conv,source:source.message};
}
function note(content:string,ids:string[],id=randomUUID()) {
 return {id,content,kind:"user_statement" as const,correction:null,status:"current",version:1,
 sourceMessageIds:JSON.stringify(ids),sourceMessageVersions:JSON.stringify(Object.fromEntries(ids.map(id=>[id,1])))};
}
function lock(s:ReturnType<typeof setup>) {
 syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note("用户希望提前通知。",[s.source.id])]);
 const view=getPrivateMemory(s.user.id),item=view.items[0];
 expect(correctPrivateMemoryItem(s.user.id,item.id,"用户希望提前一天通知。",item.version,view.revision)).not.toHaveProperty("error");
 return getPrivateMemory(s.user.id).items[0];
}
describe("independently grounded notes alongside protected citations",()=>{
 it("adds another fact from the same unprotected source",()=>{
 const s=setup(); syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note("用户希望提前通知。",[s.source.id])]);
 syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note("用户喜欢做面包。",[s.source.id])]);
 expect(getPrivateMemory(s.user.id).items).toHaveLength(2);
 });
 it("deduplicates identical facts when notes IDs change",()=>{
 const s=setup();for(let i=0;i<2;i++)syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note("用户喜欢做面包。",[s.source.id])]);
 expect(getPrivateMemory(s.user.id).items).toHaveLength(1);
 });
 it("admits an independent exact statement despite an extra locked citation and preserves the lock",()=>{
 const s=setup(),locked=lock(s);const fresh=core.addUserMessage(s.user.id,s.conv.id,"用户喜欢做面包。");if(!fresh)throw Error("fresh unavailable");
 syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note("用户喜欢做面包。",[s.source.id,fresh.message.id])]);
 const items=getPrivateMemory(s.user.id).items;
 expect(items.find(i=>i.id===locked.id)).toEqual(locked);
 expect(items.find(i=>i.content==="用户喜欢做面包。")?.sourceMessageIds).toEqual([fresh.message.id]);
 expect(getPrivateMemoryReplySnapshot(s.user.id,"做面包").items.some(i=>i.content==="用户喜欢做面包。")).toBe(true);
 });
 it("does not overwrite a user correction with a same-source conflicting note",()=>{
 const s=setup(),locked=lock(s);
 syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note("用户希望临时通知。",[s.source.id])]);
 expect(getPrivateMemory(s.user.id).items).toEqual([locked]);
 });
 it("does not bypass locks with paraphrases unsupported by the independent message",()=>{
 const s=setup(),locked=lock(s);const fresh=core.addUserMessage(s.user.id,s.conv.id,"用户喜欢做面包。");if(!fresh)throw Error("fresh unavailable");
 syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note("用户希望临时通知。",[s.source.id,fresh.message.id])]);
 expect(getPrivateMemory(s.user.id).items).toEqual([locked]);
 });
 it("does not use an extra new source to bypass forgetting",()=>{
 const s=setup(),locked=lock(s),view=getPrivateMemory(s.user.id);
 expect(forgetPrivateMemoryItem(s.user.id,locked.id,locked.version,view.revision)).not.toHaveProperty("error");
 const fresh=core.addUserMessage(s.user.id,s.conv.id,"用户喜欢做面包。");if(!fresh)throw Error("fresh unavailable");
 syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note("用户喜欢做面包。",[s.source.id,fresh.message.id])]);
 expect(getPrivateMemory(s.user.id).items).toEqual([]);
 });
 it("rejects another owner's source even if its text exactly matches",()=>{
 const s=setup(),other=setup();
 syncPrivateMemoryFromNotes(s.user.id,s.conv.id,[note(other.source.content,[other.source.id])]);
 expect(getPrivateMemory(s.user.id).items).toEqual([]);
 expect(getPrivateMemoryReplySnapshot(other.user.id,"安排变化").items).toEqual([]);
 });
});
