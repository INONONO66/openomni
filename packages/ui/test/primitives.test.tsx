import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, CodeFence, CodeToken, Disclosure, IconButton, Input, Row, State } from "../src";

/**
 * Primitives are asserted through their rendered markup: the class map a
 * variant/tone selects, and the semantics Base UI contributes.
 */

describe("Button", () => {
  test("Given no variant, When rendered, Then it is a native ghost button", () => {
    const html = renderToStaticMarkup(<Button>Run</Button>);

    expect(html).toStartWith("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('data-variant="ghost"');
  });

  test("Given each variant, When rendered, Then only primary spends the accent", () => {
    const primary = renderToStaticMarkup(<Button variant="primary">P</Button>);
    const secondary = renderToStaticMarkup(<Button variant="secondary">S</Button>);
    const ghost = renderToStaticMarkup(<Button variant="ghost">G</Button>);

    expect(primary).toContain("bg-accent");
    expect(secondary).not.toContain("accent");
    expect(ghost).not.toContain("accent");
    expect(new Set([primary, secondary, ghost]).size).toBe(3);
  });

  test("Given any variant, When rendered, Then no variant draws a border", () => {
    // A drawn outline around a control is the box this system replaced with
    // whitespace and a tonal step.
    for (const variant of ["primary", "secondary", "ghost"] as const) {
      expect(renderToStaticMarkup(<Button variant={variant}>x</Button>)).not.toContain("border");
    }
  });

  test("Given each size, When rendered, Then a distinct control height is selected", () => {
    expect(renderToStaticMarkup(<Button size="sm">S</Button>)).toContain("h-control-sm");
    expect(renderToStaticMarkup(<Button size="md">M</Button>)).toContain("h-control-md");
  });

  test("Given any variant, When rendered, Then the full interaction state set is covered", () => {
    for (const variant of ["primary", "secondary", "ghost"] as const) {
      const html = renderToStaticMarkup(<Button variant={variant}>x</Button>);
      // A variant that styles hover but not press leaves the click unacknowledged.
      expect(html).toContain("hover:");
      expect(html).toContain("active:");
      expect(html).toContain("focus-ring");
      expect(html).toContain("disabled:");
      expect(html).toContain("transition-quiet");
    }
  });

  test("Given a disabled button, When rendered, Then the state reaches the platform and CSS", () => {
    const html = renderToStaticMarkup(<Button disabled>Stop</Button>);

    expect(html).toContain("disabled=");
    expect(html).toContain('data-disabled=""');
    expect(html).toContain("disabled:pointer-events-none");
  });

  test("Given an icon child, When rendered, Then the slot is declared on the control", () => {
    // Tailwind arbitrary variants are HTML-escaped inside the class attribute,
    // so these assert the form that actually ships.
    const html = renderToStaticMarkup(<Button>Run</Button>);

    expect(html).toContain("[&amp;_svg]:shrink-0");
    expect(html).toContain("[&amp;_svg]:pointer-events-none");
  });
});

describe("IconButton", () => {
  test("Given a label, When rendered, Then it names itself and stays square", () => {
    const html = renderToStaticMarkup(
      <IconButton label="New session" size="sm">
        <svg aria-hidden="true" />
      </IconButton>,
    );

    expect(html).toContain('aria-label="New session"');
    expect(html).toContain("size-control-sm");
  });

  test("Given no variant, When rendered, Then it is ghost with the shared state set", () => {
    const html = renderToStaticMarkup(
      <IconButton label="Close">
        <svg aria-hidden="true" />
      </IconButton>,
    );

    expect(html).not.toContain("bg-accent");
    expect(html).toContain("hover:bg-hover");
    expect(html).toContain("active:");
    expect(html).toContain("focus-ring");
  });
});

describe("State", () => {
  const TIERS = ["live", "attention", "settled"] as const;

  test("Given any label, When rendered, Then the word itself is the readout", () => {
    // The primitive prints what it is given: it owns the tonal rule, not the
    // vocabulary, so an arbitrary word must render as faithfully as a
    // domain one.
    for (const label of ["running", "waiting", "queued", "부트"]) {
      const html = renderToStaticMarkup(<State label={label} tier="attention" />);

      expect(html).toContain(`>${label}<`);
      expect(html).toContain(`data-state="${label}"`);
    }
  });

  test("Given the live tier, When rendered, Then it is the only tier using the accent", () => {
    // Only `live` is a claim about right now; everything else recedes.
    expect(renderToStaticMarkup(<State label="running" tier="live" />)).toContain("text-accent");
    for (const tier of ["attention", "settled"] as const) {
      expect(renderToStaticMarkup(<State label="x" tier={tier} />)).not.toContain("accent");
    }
  });

  test("Given the tiers, When compared, Then each takes its own step of the ramp", () => {
    // Three tiers collapsed onto two tones would make one of them decorative.
    const tones = TIERS.map((tier) =>
      /class="[^"]*?(text-[\w-]+)"/.exec(renderToStaticMarkup(<State label="x" tier={tier} />)),
    ).map((hit) => hit?.[1]);

    expect(new Set(tones).size).toBe(TIERS.length);
  });

  test("Given any tier, When rendered, Then there is no dot, border, or fill", () => {
    for (const tier of TIERS) {
      const html = renderToStaticMarkup(<State label="x" tier={tier} />);

      expect(html).not.toContain("rounded-full");
      expect(html).not.toContain("border");
      expect(html).not.toContain("bg-");
    }
  });
});

describe("Row", () => {
  test("Given a current row, When rendered, Then selection is surface plus weight", () => {
    const html = renderToStaticMarkup(<Row current>ledger</Row>);

    expect(html).toContain('aria-current="true"');
    expect(html).toContain("bg-raised");
    expect(html).toContain("font-medium");
  });

  test("Given a current row, When rendered, Then no accent marker bar is drawn", () => {
    // Bold text on a raised surface is already the loudest thing in the column;
    // an accent bar would repeat what weight already said, and it would spend
    // the one chroma on "where you are" instead of on "what is live".
    const html = renderToStaticMarkup(<Row current>ledger</Row>);

    expect(html).not.toContain("accent");
  });

  test("Given a current row, When rendered, Then its edge is a hairline, never a heavy rule", () => {
    // The border a selected row DOES carry: one pixel in the surface tier, to
    // give a deliberately quiet fill a definite edge. Anything thicker, or in
    // a text tone, is the boxed-in card this system removed.
    const html = renderToStaticMarkup(<Row current>ledger</Row>);

    expect(html).toContain("border-line-surface");
    expect(html).not.toMatch(/border-[lrtbxy]?-?[2-9]\b/);
    expect(html).not.toContain("border-fg");
  });

  test("Given a row, When hovered or at rest, Then the border is present in both states", () => {
    // The layout guarantee: `border` is declared unconditionally and only its
    // COLOR changes, so a row never gains or loses a 1px box under the pointer.
    // A border that appears on hover shifts the row's content and the whole
    // column twitches.
    const idle = renderToStaticMarkup(<Row>ledger</Row>);
    const current = renderToStaticMarkup(<Row current>ledger</Row>);

    expect(idle).toContain("border-transparent");
    expect(idle).toContain("hover:border-line-surface");
    for (const html of [idle, current]) {
      expect(html).toMatch(/\bborder\b/);
    }
  });

  test("Given an unselected row, When rendered, Then it answers hover, press, and focus", () => {
    const html = renderToStaticMarkup(<Row>ledger</Row>);

    expect(html).toContain("hover:bg-hover");
    expect(html).toContain("active:bg-active");
    expect(html).toContain("focus-ring");
    expect(html).not.toContain('aria-current="true"');
  });

  test("Given a current row, When rendered, Then it drops the hover surface it occupies", () => {
    expect(renderToStaticMarkup(<Row current>x</Row>)).not.toContain("hover:bg-hover");
  });

  test("Given a one-line row, When rendered, Then it sits on the fixed rhythm step", () => {
    expect(renderToStaticMarkup(<Row>x</Row>)).toContain("h-row");
  });

  test("Given a two-line row, When rendered, Then the height is released so nothing clips", () => {
    // The second line is content. A row that keeps `h-row` here silently
    // truncates the very thing the second line exists to say.
    const html = renderToStaticMarkup(<Row lines="two">x</Row>);

    expect(html).not.toContain("h-row");
    expect(html).not.toContain("overflow-hidden");
    expect(html).toContain("flex-col");
  });
});

describe("Disclosure", () => {
  test("Given an open disclosure, When rendered, Then the trigger reports expansion", () => {
    const html = renderToStaticMarkup(<Disclosure label="kernel">rows</Disclosure>);

    expect(html).toContain("<button");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("aria-controls=");
  });

  test("Given a closed disclosure, When rendered, Then its panel is absent, not hidden", () => {
    const html = renderToStaticMarkup(
      <Disclosure defaultOpen={false} label="kernel">
        rows
      </Disclosure>,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(">rows<");
  });

  test("Given an open disclosure, When rendered, Then the panel opens one step looser than a row", () => {
    // Grouping here cannot be a box or a line, so it is whitespace: a label on
    // the same rhythm step as its first row reads as a sibling of it.
    const html = renderToStaticMarkup(<Disclosure label="kernel">rows</Disclosure>);

    expect(html).toContain("pt-group-gap");
  });

  test("Given a group header, When rendered, Then the label is overline text with no icon slot", () => {
    const html = renderToStaticMarkup(<Disclosure label="kernel">rows</Disclosure>);

    expect(html).toContain("text-overline");
    expect(html).toContain("uppercase");
    // The chevron reports state by rotation and is the only glyph allowed here.
    expect(html).toContain("group-data-[panel-open]:rotate-90");
    expect(html).toContain('aria-hidden="true"');
  });

  test("Given trailing metadata, When rendered, Then it appears in the header", () => {
    const html = renderToStaticMarkup(
      <Disclosure label="kernel" trailing={<span>3</span>}>
        rows
      </Disclosure>,
    );

    expect(html).toContain(">3<");
  });
});

describe("Input", () => {
  test("Given a label, When rendered, Then the control is bound to it by id", () => {
    const html = renderToStaticMarkup(<Input label="Search sessions" placeholder="Search" />);

    expect(html).toContain("<input");
    expect(html).toContain('placeholder="Search"');

    const labelFor = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
    const inputId = html.match(/<input[^>]*id="([^"]+)"/)?.[1];
    expect(labelFor).toBeDefined();
    expect(inputId).toBe(labelFor);
  });

  test("Given a label, When rendered, Then the accessible name is present but hidden", () => {
    const html = renderToStaticMarkup(<Input label="Search sessions" />);

    expect(html).toContain("sr-only");
    expect(html).toContain(">Search sessions<");
  });

  test("Given an explicit id, When rendered, Then it wins over the generated one", () => {
    const html = renderToStaticMarkup(<Input id="filter-field" label="Filter" />);

    expect(html).toContain('for="filter-field"');
    expect(html).toContain('id="filter-field"');
  });

  test("Given a resting field, When rendered, Then focus is the accent underline only", () => {
    const html = renderToStaticMarkup(<Input label="Filter" />);

    expect(html).toStartWith("<label");
    expect(html).toContain("focus-within:border-b-accent");
    expect(html).toContain("border-b-transparent");
  });

  test("Given a resting field, When rendered, Then it carries a quiet surface, not nothing", () => {
    // A field with no surface at rest is not a field: it is a placeholder
    // floating in a column with nothing saying it can be typed into. The
    // elevation IS the affordance, which is why there is no icon to add.
    //
    // The surface belongs to the WRAPPER; the control inside stays transparent
    // so the whole field reads as one tonal step rather than two.
    const html = renderToStaticMarkup(<Input label="Search sessions" />);
    const wrapper = html.slice(0, html.indexOf("<input"));

    expect(wrapper).toContain("bg-raised");
    expect(wrapper).not.toContain("bg-transparent");
    expect(html).not.toContain("<svg");
  });

  test("Given a disabled field, When rendered, Then it is reported natively and dimmed", () => {
    const html = renderToStaticMarkup(<Input disabled label="Filter" />);

    expect(html).toContain("disabled=");
    expect(html).toContain("has-disabled:opacity-50");
    expect(html).toContain("has-disabled:cursor-not-allowed");
  });
});

describe("CodeFence", () => {
  test("Given a fence, When rendered, Then a hairline edge lets the fill stay faint", () => {
    // The fill and the edge are ONE decision. Without a border the fill was the
    // only thing defining the region, so it had to be strong enough to read
    // unaided — which is a grey box. One pixel of `line-surface` lets the fill
    // drop to `sunken`, the lightest step off the column (~1.05:1 from `bg`):
    // barely a tint, yet unmistakably a region, because the edge now does the
    // defining the fill used to strain at.
    const html = renderToStaticMarkup(<CodeFence lang="rust">let x = 1;</CodeFence>);

    expect(html).toContain("bg-sunken");
    expect(html).toContain("border-line-surface");
    expect(html).not.toContain("bg-raised");
  });

  test("Given a fence, When rendered, Then its edge is a hairline on the surface radius", () => {
    // A fence is a bigger rectangle than a row but the same KIND of thing, so
    // it takes the shared surface radius rather than a bespoke corner — two
    // answers to "how round is a surface here" would read as inconsistency
    // long before it read as hierarchy.
    const html = renderToStaticMarkup(<CodeFence lang="rust">let x = 1;</CodeFence>);

    expect(html).toContain("rounded-md");
    expect(html).not.toMatch(/border-[lrtbxy]?-?[2-9]\b/);
  });
});

describe("CodeToken", () => {
  test("Given every tone, When rendered, Then none of them spends chroma", () => {
    // The accent is reserved for live state, so a fence reads by tone and
    // weight alone and never becomes the loudest region on the surface.
    for (const tone of [
      "plain",
      "keyword",
      "string",
      "number",
      "comment",
      "fn",
      "punct",
    ] as const) {
      expect(renderToStaticMarkup(<CodeToken tone={tone}>x</CodeToken>)).not.toContain("accent");
    }
  });

  test("Given distinct tones, When rendered, Then they are still distinguishable", () => {
    const keyword = renderToStaticMarkup(<CodeToken tone="keyword">let</CodeToken>);
    const comment = renderToStaticMarkup(<CodeToken tone="comment">rem</CodeToken>);

    expect(keyword).not.toBe(comment);
  });
});
