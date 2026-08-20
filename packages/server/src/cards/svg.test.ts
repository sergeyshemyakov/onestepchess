import { expect, it } from "vitest";
import { buildCardSvg, type CardData } from "./svg.js";

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function cardSvg(overrides: Partial<CardData> = {}): string {
  return buildCardSvg({
    gameId: "gm_uljwmk6itj34",
    authorNickname: null,
    outcome: "WON",
    fen: STARTING_FEN,
    moveUci: "e2e4",
    thinkingTimeMs: 103_000,
    wonMicroUsdc: 100_000,
    ...overrides,
  });
}

it("share_card_displays_game_id_like_the_replay_page", () => {
  const svg = cardSvg();

  expect(svg).toContain('data-text="game uljwmk6itj34"');
  expect(svg).not.toContain("gm_uljwmk6itj34");
});

it("share_card_win_panel_shows_title_thinking_time_net_won_and_domain", () => {
  const svg = cardSvg();

  expect(svg).toContain('data-text="I WON"');
  expect(svg).toContain('data-text="thought for: 1m 43s"');
  expect(svg).toContain('data-text="won: $0.10"');
  expect(svg).toContain('data-text="onestepchess.xyz"');
});

it("share_card_omits_the_won_line_unless_the_author_won", () => {
  for (const outcome of ["LOST", "DRAW"] as const) {
    const svg = cardSvg({ outcome });
    expect(svg).not.toContain('data-text="won:');
    expect(svg).toContain(
      outcome === "LOST" ? 'data-text="I LOST"' : 'data-text="DRAW"',
    );
  }
  expect(cardSvg({ wonMicroUsdc: null })).not.toContain('data-text="won:');
});

it("share_card_board_uses_the_web_green_theme_and_a_faint_arrow", () => {
  const svg = cardSvg();

  // --sql / --sqd / --ph / --accent from web/src/styles/tokens.css (green
  // theme); the arrow dropped from 0.85 to 0.5 opacity by Sergey's ruling.
  expect(svg).toContain('fill="#0b2413"');
  expect(svg).toContain('fill="#051309"');
  expect(svg).toContain('fill="#41ff70"');
  expect(svg).toContain('<g opacity="0.5"><line');
  expect(svg).toContain('stroke="#ffb347"');
});

it("share_card_renders_text_as_paths_never_system_fonts", () => {
  expect(cardSvg()).not.toContain("font-family");
});
