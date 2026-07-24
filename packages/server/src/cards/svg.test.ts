import { expect, it } from "vitest";
import { buildCardSvg } from "./svg.js";

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function cardSvg(gameId = "gm_uljwmk6itj34"): string {
  return buildCardSvg({
    gameId,
    authorNickname: null,
    outcome: "WON",
    fen: STARTING_FEN,
    moveUci: "e2e4",
  });
}

it("share_card_displays_game_id_like_the_replay_page", () => {
  const svg = cardSvg();

  expect(svg).toContain(">uljwmk6itj34</text>");
  expect(svg).not.toContain("gm_uljwmk6itj34");
});

it("share_card_omits_the_one_move_staked_in_usdc_line", () => {
  expect(cardSvg()).not.toContain("one move, staked in USDC");
});
