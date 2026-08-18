import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CapturedPieces } from "./CapturedPieces.jsx";

afterEach(cleanup);

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Black is missing its queen and a pawn; white is missing two pawns.
const MID = "rnb1kbnr/ppppppp1/8/8/8/8/PPPPPP2/RNBQKBNR w KQkq - 0 12";

it("captured_rows_show_placeholders_at_the_start_position", () => {
  render(<CapturedPieces fen={START} yourSide="white" />);
  expect(screen.getByTestId("captures-you").textContent).toContain("—");
  expect(screen.getByTestId("captures-opp").textContent).toContain("—");
});

it("captured_rows_group_by_captor_oriented_to_your_side", () => {
  render(<CapturedPieces fen={MID} yourSide="white" />);
  // You play white, so your row lists the two missing black pieces.
  expect(screen.getByTestId("captures-you").textContent).toContain(
    "you captured: queen, pawn",
  );
  expect(screen.getByTestId("captures-opp").textContent).toContain(
    "opponent captured: pawn, pawn",
  );
});

it("captured_rows_flip_when_you_play_black", () => {
  render(<CapturedPieces fen={MID} yourSide="black" />);
  expect(screen.getByTestId("captures-you").textContent).toContain(
    "you captured: pawn, pawn",
  );
  expect(screen.getByTestId("captures-opp").textContent).toContain(
    "opponent captured: queen, pawn",
  );
});
