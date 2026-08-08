import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { Rules } from "./Rules.jsx";

afterEach(cleanup);

it("rules_page_defaults_to_the_human_tab_with_verbatim_meta_rules", () => {
  const client = mockClient();
  const view = render(
    <Providers client={client}>
      <Rules meta={metaFixture} />
    </Providers>,
  );

  expect(view.container.querySelector(".guide")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "THE RULES" })).not.toBeNull();
  expect(screen.getByTestId("rules-verbatim").textContent).toContain(
    metaFixture.rules,
  );
  expect(screen.queryByTestId("rules-agent-tab")).toBeNull();
});

it("rules_page_agent_tab_links_the_machine_docs", () => {
  const client = mockClient();
  render(
    <Providers client={client}>
      <Rules meta={metaFixture} />
    </Providers>,
  );

  fireEvent.click(screen.getByRole("tab", { name: "FOR AGENTS" }));
  expect(screen.getByTestId("rules-agent-tab")).not.toBeNull();
  expect(screen.queryByTestId("rules-verbatim")).toBeNull();
  expect(
    screen.getByRole("link", { name: "llms.txt" }).getAttribute("href"),
  ).toBe(metaFixture.docs.llms);
  expect(
    screen.getByRole("link", { name: "openapi" }).getAttribute("href"),
  ).toBe(metaFixture.docs.openapi);
});
