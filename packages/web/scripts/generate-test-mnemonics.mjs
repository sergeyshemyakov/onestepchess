import algosdk from "algosdk";

const ACCOUNT_COUNT = 10;

for (let index = 0; index < ACCOUNT_COUNT; index += 1) {
  const account = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

  console.log(`${index + 1}. ${mnemonic}`);
}
