import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// React's static renderer escapes these five entities in attribute values.
function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function attributes(node: ReactNode, selector = "*") {
  const elements: Record<string, string>[] = [];
  new HTMLRewriter()
    .on(selector, {
      element(element) {
        elements.push(
          Object.fromEntries(
            [...element.attributes].map(([name, value]) => [name, unescapeAttribute(value)]),
          ),
        );
      },
    })
    .transform(renderToStaticMarkup(node));
  return elements;
}

export function textContent(node: ReactNode, selector: string): string {
  const chunks: string[] = [];
  new HTMLRewriter()
    .on(selector, {
      text(chunk) {
        chunks.push(chunk.text);
      },
    })
    .transform(renderToStaticMarkup(node));
  return unescapeAttribute(chunks.join(""));
}

export function classes(node: ReactNode, selector = "*"): string[] {
  return attributes(node, selector).flatMap((element) =>
    (element.class ?? "").split(/\s+/).filter(Boolean),
  );
}
