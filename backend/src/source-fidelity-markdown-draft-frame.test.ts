import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardPrivateReplyFidelity, SourceFidelityError } from "./source-fidelity.js";

// Portable fictional regression fixture; no database or provider metadata is distributed.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/markdown-draft-frame.synthetic.json", import.meta.url), "utf8"));
const source: { content: string; version: number; status: string } = fixture.source;
const reply: string = fixture.reply;
const lines = reply.split("\n");
const quoteStartLine = lines.findIndex(line => /^>\s?/u.test(line));
const quoteBody = lines.slice(quoteStartLine).filter(line => /^>\s?/u.test(line)).map(line => line.replace(/^>\s?/u, "")).join("\n").trim();
const prefix = lines.slice(0, quoteStartLine).join("\n").replace(/[ \t\n]+$/u, "");
const sameParagraph = prefix.split(/\n[ \t]*\n/u).at(-1)!.trim();
const framed = `你可以对她说：\n> ${quoteBody}`;
const paired = `你可以对她说：“${quoteBody}”`;

describe("Markdown draft frame and same-paragraph partner role", () => {
  it("accepts a synthetic B-to-partner response without private Memory", () => {
    expect(guardPrivateReplyFidelity(reply, { currentMessage: source.content })).toBe(reply);
  });

  it("accepts the same script with an explicit B-to-partner frame in Markdown and paired quotes", () => {
    expect(guardPrivateReplyFidelity(framed, { currentMessage: source.content })).toBe(framed);
    expect(guardPrivateReplyFidelity(paired, { currentMessage: source.content })).toBe(paired);
    const naturalFrame = `你开口时可以先对她说说自己的情况，再把话交给她。比如：\n> ${quoteBody}`;
    expect(guardPrivateReplyFidelity(naturalFrame, { currentMessage: source.content })).toBe(naturalFrame);
  });

  it("keeps same-paragraph role cues across line wrapping and Markdown blank lines with inline quotes", () => {
    const wrappedIntro = sameParagraph.replace(/，/u, ",\n");
    const multiline = `${wrappedIntro}\n\n> “别多想”只是原话。\n>\n> ${quoteBody}`;
    expect(guardPrivateReplyFidelity(multiline, { currentMessage: source.content })).toBe(multiline);
  });

  it("does not infer a recipient from only ‘比如’, an unframed assertion, a friend, or a delegated speaker", () => {
    const generic = `比如：\n> ${quoteBody}`;
    expect(() => guardPrivateReplyFidelity(generic, { currentMessage: source.content })).toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity("你一直在等", { currentMessage: source.content })).toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity("你可以对朋友说：‘我知道你一直在等。’", { currentMessage: source.content })).toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity("你可以让她对你说：‘我知道你一直在等。’", { currentMessage: source.content })).toThrow(SourceFidelityError);
  });

  it("requires an affirmed user opening before inheriting the partner role across 比如", () => {
    const accepted = `你先开口说清自己的情况，再把话交给她。比如：\n> ${quoteBody}`;
    expect(guardPrivateReplyFidelity(accepted, { currentMessage: source.content })).toBe(accepted);
    for (const framing of [
      "你不用开口，把话交给她。比如：",
      "你不需要开口，把话交给她。比如：",
      "你不要开口，把话交给她。比如：",
      "你不开口，开场先说清你的情况，最后把话交给她。比如：",
      "你先别开口，开场先说清你的情况，最后把话交给她。比如：",
      "你是否开口还没定，把话交给她。比如：",
      "你要不要开口还没定，把话交给她。比如：",
      "由她先开口，再把话交给她。比如：",
      "让朋友先开口，再把话交给她。比如：",
      "你先开口，再把话交给某个人。比如：",
    ]) {
      expect(() => guardPrivateReplyFidelity(`${framing}\n> ${quoteBody}`, { currentMessage: source.content }), framing)
        .toThrow(SourceFidelityError);
    }
  });

  it("rejects mixed recipients and reported partner speech nested inside a Markdown draft", () => {
    const mixed = `你先向小王开口，最后把话交给她。比如：\n> ${quoteBody}`;
    expect(() => guardPrivateReplyFidelity(mixed, { currentMessage: source.content })).toThrow(SourceFidelityError);
    for (const speaker of ["她", "老王", "小林", "有人"]) {
      const reported = `${sameParagraph}\n\n> ${speaker}说‘我知道你一直在等。’`;
      expect(() => guardPrivateReplyFidelity(reported, { currentMessage: source.content })).toThrow(SourceFidelityError);
    }
  });

  it("rejects a waiting claim inside a nested Markdown quote instead of inheriting the outer speaker", () => {
    const nested = `你可以对她说：\n> 她对我说：\n> > 我知道你一直在等。`;
    expect(() => guardPrivateReplyFidelity(nested, { currentMessage: source.content })).toThrow(SourceFidelityError);
    const compactNested = `你可以对她说：\n>> 她对我说：\n>> 我知道你一直在等。`;
    expect(() => guardPrivateReplyFidelity(compactNested, { currentMessage: source.content })).toThrow(SourceFidelityError);
    const nestedMarkerBeforeHit = `你可以对她说：\n> 她对我说：\n> > 这段话另有说话人。\n> 我知道你一直在等。`;
    expect(() => guardPrivateReplyFidelity(nestedMarkerBeforeHit, { currentMessage: source.content })).toThrow(SourceFidelityError);
  });

  it("rejects an unknown recipient from a source with an explicit communication intent", () => {
    const currentMessage = "我知道她一直在等我。我想把情况告诉朋友。";
    expect(() => guardPrivateReplyFidelity("比如：‘我知道你一直在等。’", { currentMessage })).toThrow(SourceFidelityError);
  });

  it("still rejects fabricated waiting outside an otherwise valid Markdown quote", () => {
    const withOutsideClaim = `${sameParagraph}\n\n> ${quoteBody}\n\n你一直在等。`;
    expect(() => guardPrivateReplyFidelity(withOutsideClaim, { currentMessage: source.content })).toThrow(SourceFidelityError);
  });
});
