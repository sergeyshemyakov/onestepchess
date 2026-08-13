import { describe, expect, it } from "vitest";
import type {
  DecodedPayment,
  DecodeResult,
  FundingInstruction,
  PaymentChallenge,
  PaymentRail,
  PaymentRequired,
  PaymentRequirements,
  PayoutInstruction,
  PreparedFunding,
  PreparedPayouts,
  PreparedSubmission,
  SendResult,
  SettleResult,
  SignedSubmitResult,
  StakeQuote,
  SweepQuote,
  SweepTxn,
  TxStatus,
  VerifyFailure,
  VerifyResult,
} from "../index.js";
import { RailError } from "../index.js";
import type { MicroUsdc } from "../types.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;

type PublicRailTypes = [
  StakeQuote,
  PaymentRequirements,
  PaymentRequired,
  PaymentChallenge,
  DecodedPayment,
  DecodeResult,
  VerifyFailure,
  VerifyResult,
  SettleResult,
  PayoutInstruction,
  FundingInstruction,
  SendResult,
  SignedSubmitResult,
  PreparedPayouts,
  PreparedFunding,
  PreparedSubmission,
  SweepTxn,
  SweepQuote,
  TxStatus,
  PaymentRail,
];
type MoneyFieldsUseCoreCanon = Assert<
  Equal<
    | StakeQuote["amountMicroUsdc"]
    | DecodedPayment["amountMicroUsdc"]
    | PayoutInstruction["amountMicroUsdc"],
    MicroUsdc
  >
>;
const typeAssertions: [PublicRailTypes | undefined, MoneyFieldsUseCoreCanon] = [
  undefined,
  true,
];

describe("PaymentRail public port", () => {
  it("exports every rail type through the core barrel and reuses MicroUsdc", () => {
    expect(typeAssertions).toEqual([undefined, true]);
  });

  it("RailError preserves its pinned code and name", () => {
    const error = new RailError("NOT_READY", "health has not warmed the rail");
    expect(error).toMatchObject({
      name: "RailError",
      code: "NOT_READY",
      message: "health has not warmed the rail",
    });
  });
});
