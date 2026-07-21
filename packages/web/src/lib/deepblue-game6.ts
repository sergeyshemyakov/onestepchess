// §4.7 — Deep Blue–Kasparov, game 6, 1997, bundled so the landing strip
// needs no network. `fenAfter` is precomputed so every replay surface stays
// FEN-indexed (F-W6: no client-side move recomputation).

export type BundledPly = {
  readonly from: string;
  readonly to: string;
  readonly promo?: string;
  readonly capture?: boolean;
  readonly san: string;
  readonly fenAfter: string;
};

export const DEEP_BLUE_GAME6: {
  readonly plies: readonly BundledPly[];
  readonly result: "1-0";
} = {
  result: "1-0",
  plies: [
    {
      from: "e2",
      to: "e4",
      san: "e4",
      fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    },
    {
      from: "c7",
      to: "c6",
      san: "c6",
      fenAfter: "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    },
    {
      from: "d2",
      to: "d4",
      san: "d4",
      fenAfter: "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2",
    },
    {
      from: "d7",
      to: "d5",
      san: "d5",
      fenAfter: "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3",
    },
    {
      from: "b1",
      to: "c3",
      san: "Nc3",
      fenAfter:
        "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq - 1 3",
    },
    {
      from: "d5",
      to: "e4",
      capture: true,
      san: "dxe4",
      fenAfter: "rnbqkbnr/pp2pppp/2p5/8/3Pp3/2N5/PPP2PPP/R1BQKBNR w KQkq - 0 4",
    },
    {
      from: "c3",
      to: "e4",
      capture: true,
      san: "Nxe4",
      fenAfter: "rnbqkbnr/pp2pppp/2p5/8/3PN3/8/PPP2PPP/R1BQKBNR b KQkq - 0 4",
    },
    {
      from: "b8",
      to: "d7",
      san: "Nd7",
      fenAfter: "r1bqkbnr/pp1npppp/2p5/8/3PN3/8/PPP2PPP/R1BQKBNR w KQkq - 1 5",
    },
    {
      from: "e4",
      to: "g5",
      san: "Ng5",
      fenAfter: "r1bqkbnr/pp1npppp/2p5/6N1/3P4/8/PPP2PPP/R1BQKBNR b KQkq - 2 5",
    },
    {
      from: "g8",
      to: "f6",
      san: "Ngf6",
      fenAfter:
        "r1bqkb1r/pp1npppp/2p2n2/6N1/3P4/8/PPP2PPP/R1BQKBNR w KQkq - 3 6",
    },
    {
      from: "f1",
      to: "d3",
      san: "Bd3",
      fenAfter:
        "r1bqkb1r/pp1npppp/2p2n2/6N1/3P4/3B4/PPP2PPP/R1BQK1NR b KQkq - 4 6",
    },
    {
      from: "e7",
      to: "e6",
      san: "e6",
      fenAfter:
        "r1bqkb1r/pp1n1ppp/2p1pn2/6N1/3P4/3B4/PPP2PPP/R1BQK1NR w KQkq - 0 7",
    },
    {
      from: "g1",
      to: "f3",
      san: "N1f3",
      fenAfter:
        "r1bqkb1r/pp1n1ppp/2p1pn2/6N1/3P4/3B1N2/PPP2PPP/R1BQK2R b KQkq - 1 7",
    },
    {
      from: "h7",
      to: "h6",
      san: "h6",
      fenAfter:
        "r1bqkb1r/pp1n1pp1/2p1pn1p/6N1/3P4/3B1N2/PPP2PPP/R1BQK2R w KQkq - 0 8",
    },
    {
      from: "g5",
      to: "e6",
      capture: true,
      san: "Nxe6",
      fenAfter:
        "r1bqkb1r/pp1n1pp1/2p1Nn1p/8/3P4/3B1N2/PPP2PPP/R1BQK2R b KQkq - 0 8",
    },
    {
      from: "d8",
      to: "e7",
      san: "Qe7",
      fenAfter:
        "r1b1kb1r/pp1nqpp1/2p1Nn1p/8/3P4/3B1N2/PPP2PPP/R1BQK2R w KQkq - 1 9",
    },
    {
      from: "e1",
      to: "g1",
      san: "O-O",
      fenAfter:
        "r1b1kb1r/pp1nqpp1/2p1Nn1p/8/3P4/3B1N2/PPP2PPP/R1BQ1RK1 b kq - 2 9",
    },
    {
      from: "f7",
      to: "e6",
      capture: true,
      san: "fxe6",
      fenAfter:
        "r1b1kb1r/pp1nq1p1/2p1pn1p/8/3P4/3B1N2/PPP2PPP/R1BQ1RK1 w kq - 0 10",
    },
    {
      from: "d3",
      to: "g6",
      san: "Bg6+",
      fenAfter:
        "r1b1kb1r/pp1nq1p1/2p1pnBp/8/3P4/5N2/PPP2PPP/R1BQ1RK1 b kq - 1 10",
    },
    {
      from: "e8",
      to: "d8",
      san: "Kd8",
      fenAfter:
        "r1bk1b1r/pp1nq1p1/2p1pnBp/8/3P4/5N2/PPP2PPP/R1BQ1RK1 w - - 2 11",
    },
    {
      from: "c1",
      to: "f4",
      san: "Bf4",
      fenAfter:
        "r1bk1b1r/pp1nq1p1/2p1pnBp/8/3P1B2/5N2/PPP2PPP/R2Q1RK1 b - - 3 11",
    },
    {
      from: "b7",
      to: "b5",
      san: "b5",
      fenAfter:
        "r1bk1b1r/p2nq1p1/2p1pnBp/1p6/3P1B2/5N2/PPP2PPP/R2Q1RK1 w - - 0 12",
    },
    {
      from: "a2",
      to: "a4",
      san: "a4",
      fenAfter:
        "r1bk1b1r/p2nq1p1/2p1pnBp/1p6/P2P1B2/5N2/1PP2PPP/R2Q1RK1 b - - 0 12",
    },
    {
      from: "c8",
      to: "b7",
      san: "Bb7",
      fenAfter:
        "r2k1b1r/pb1nq1p1/2p1pnBp/1p6/P2P1B2/5N2/1PP2PPP/R2Q1RK1 w - - 1 13",
    },
    {
      from: "f1",
      to: "e1",
      san: "Re1",
      fenAfter:
        "r2k1b1r/pb1nq1p1/2p1pnBp/1p6/P2P1B2/5N2/1PP2PPP/R2QR1K1 b - - 2 13",
    },
    {
      from: "f6",
      to: "d5",
      san: "Nd5",
      fenAfter:
        "r2k1b1r/pb1nq1p1/2p1p1Bp/1p1n4/P2P1B2/5N2/1PP2PPP/R2QR1K1 w - - 3 14",
    },
    {
      from: "f4",
      to: "g3",
      san: "Bg3",
      fenAfter:
        "r2k1b1r/pb1nq1p1/2p1p1Bp/1p1n4/P2P4/5NB1/1PP2PPP/R2QR1K1 b - - 4 14",
    },
    {
      from: "d8",
      to: "c8",
      san: "Kc8",
      fenAfter:
        "r1k2b1r/pb1nq1p1/2p1p1Bp/1p1n4/P2P4/5NB1/1PP2PPP/R2QR1K1 w - - 5 15",
    },
    {
      from: "a4",
      to: "b5",
      capture: true,
      san: "axb5",
      fenAfter:
        "r1k2b1r/pb1nq1p1/2p1p1Bp/1P1n4/3P4/5NB1/1PP2PPP/R2QR1K1 b - - 0 15",
    },
    {
      from: "c6",
      to: "b5",
      capture: true,
      san: "cxb5",
      fenAfter:
        "r1k2b1r/pb1nq1p1/4p1Bp/1p1n4/3P4/5NB1/1PP2PPP/R2QR1K1 w - - 0 16",
    },
    {
      from: "d1",
      to: "d3",
      san: "Qd3",
      fenAfter:
        "r1k2b1r/pb1nq1p1/4p1Bp/1p1n4/3P4/3Q1NB1/1PP2PPP/R3R1K1 b - - 1 16",
    },
    {
      from: "b7",
      to: "c6",
      san: "Bc6",
      fenAfter:
        "r1k2b1r/p2nq1p1/2b1p1Bp/1p1n4/3P4/3Q1NB1/1PP2PPP/R3R1K1 w - - 2 17",
    },
    {
      from: "g6",
      to: "f5",
      san: "Bf5",
      fenAfter:
        "r1k2b1r/p2nq1p1/2b1p2p/1p1n1B2/3P4/3Q1NB1/1PP2PPP/R3R1K1 b - - 3 17",
    },
    {
      from: "e6",
      to: "f5",
      capture: true,
      san: "exf5",
      fenAfter:
        "r1k2b1r/p2nq1p1/2b4p/1p1n1p2/3P4/3Q1NB1/1PP2PPP/R3R1K1 w - - 0 18",
    },
    {
      from: "e1",
      to: "e7",
      capture: true,
      san: "Rxe7",
      fenAfter:
        "r1k2b1r/p2nR1p1/2b4p/1p1n1p2/3P4/3Q1NB1/1PP2PPP/R5K1 b - - 0 18",
    },
    {
      from: "f8",
      to: "e7",
      capture: true,
      san: "Bxe7",
      fenAfter: "r1k4r/p2nb1p1/2b4p/1p1n1p2/3P4/3Q1NB1/1PP2PPP/R5K1 w - - 0 19",
    },
    {
      from: "c2",
      to: "c4",
      san: "c4",
      fenAfter: "r1k4r/p2nb1p1/2b4p/1p1n1p2/2PP4/3Q1NB1/1P3PPP/R5K1 b - - 0 19",
    },
  ],
};
