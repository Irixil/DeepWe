import { Fragment } from "react";

// Only emphasis is interpreted. HTML, links and unfinished markers remain text.
export function ReplyText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) =>
    <Fragment key={index}>{part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong>{part.slice(2, -2)}</strong> : part}</Fragment>
  )}</>;
}
