import { Account, MessageSignature } from "web3/eth/accounts";
import { TransactionReceipt } from "web3/types";

import * as encodeUtils from "./web3js-includes/Encodepacked";
import BigNumber from "bignumber.js";

const crypto = require('crypto');

// For up-to-date gas prices see: https://ethgasstation.info/
const GAS_PRICE_GWEI = 2;
const ETH_USD_PRICE = 170;

console.log(`Using gas price of ${GAS_PRICE_GWEI} GWEI`);
console.log(`Using ETH price of ${ETH_USD_PRICE} USD`);

export interface EscrowParams {
    escrowAmount: BigNumber;
    escrowTimelock: BigNumber;
    escrowReserve: string;
    escrowRefund: string;
    escrowTrade: string;
    payeeReserve: string;
    payeeTrade: string;
    escrowState: BigNumber;
    escrowerBalance: BigNumber;
    payeeBalance: BigNumber;
}

/**
 * Escrow state enum matching the Escrow.sol internal state machine
 */
export enum EscrowState {
    None,
    Unfunded,
    Open,
    PuzzlePosted,
    Closed
}

/**
 * Type of a message that is being signed and sent to an Escrow
 */
export enum MessageTypeId {
    None,
    Cashout,
    Puzzle,
    Refund
}

export function  generateAccount(): Account {
    var account = web3.eth.accounts.create();
    return account;
}

export function getCurrentTimeUnixEpoch() {
    return Math.floor(new Date().valueOf() / 1000)
}

// preimage is a hex encoded string with '0x' prefix
export function hashPreimage(preimage: string) : string {
    let hasher = crypto.createHash('sha256');
    let digest = hasher.update(preimage.slice(2), 'hex').digest('hex');
    return `0x${digest}`;
}

interface DuoSigned { eSig: MessageSignature, pSig: MessageSignature };

export class TestSigningService {

    // protocol keys
    eReserve: Account = generateAccount();
    eTrade: Account = generateAccount();
    eRefund: Account = generateAccount();
    pReserve: Account = generateAccount();
    pTrade: Account = generateAccount();

    /**
     * Sign methods will automatically add the message prefix "\x19Ethereum
     * Signed Message:\n" + message.length and then hash with keccak256 before
     * signing https://web3js.readthedocs.io/en/1.0/web3-eth-accounts.html#sign
     *
     * SoliditySha3 will automatically run encodePacked before hashing.
     * SoliditySha3(encodePacked()) however then it will be hashed twice before
     * signing, once by  soliditySha3 and once by sign
     * https://web3js.readthedocs.io/en/1.0/web3-utils.html#soliditysha3
     *
     * Instead we use _processSoliditySha3Arguments directly to just
     * encodePacked all parameters before sending to sign. This is not part of
     * web3.js's public interface so the code must be directly copied in this
     * repo until it is part of the public interface: ethereum/web3.js#2541
     */
    signCashout(addr: string, amountTraded: number): DuoSigned {
        var message = encodeUtils.encodePacked(
            {t: "address", v: addr},
            {t: "uint8", v: MessageTypeId.Cashout },
            {t: "uint256", v: amountTraded},
        );
        return {
            eSig: this.eTrade.sign(message),
            pSig: this.pTrade.sign(message)
        };
    }

    signEscrowRefund(addr: string, amountTraded: number): MessageSignature {
        var message = encodeUtils.encodePacked(
            {t: "address", v: addr},
            {t: "uint8", v: MessageTypeId.Refund },
            {t: "uint256", v: amountTraded},
        );
        return this.eRefund.sign(message);
    }

    signPuzzle(addr: string, prevAmountTraded: number, tradeAmt: number, puzzle: string, timelock: number): DuoSigned {
        var message = encodeUtils.encodePacked(
            {t: "address", v: addr},
            {t: "uint8", v: MessageTypeId.Puzzle },
            {t: "uint256", v: prevAmountTraded},
            {t: "uint256", v: tradeAmt},
            {t: "bytes32", v: puzzle},
            {t: "uint256", v: timelock},
        );
        return {
            eSig: this.eTrade.sign(message),
            pSig: this.pTrade.sign(message)
        };
    };
}

interface TxDetails { name: string, receipt: TransactionReceipt }

export class GasMeter {
    totalGasUsed = 0;
    trackedTxs: TxDetails[] = [];

    TrackGasUsage(name: string, receipt: TransactionReceipt) {
        var tx: TxDetails = { name: name, receipt: receipt };
        this.trackedTxs.push(tx);
        this.totalGasUsed += tx.receipt.gasUsed;
    }

    printAggregateGasUsage(printAllTxs = true) {
        console.log(`total ${this.printGasCost(this.totalGasUsed)}\n`);

        if(printAllTxs) {
            this.trackedTxs.forEach(tx => {
                console.log(`${tx.name} took ${this.printGasCost(tx.receipt.gasUsed)}`);
            });
        }
    }

    printGasCost(gasUsed: number) {
        let gasPrice = web3.utils.toWei(web3.utils.toBN(GAS_PRICE_GWEI), "gwei");
        let weiPrice = gasPrice.mul(web3.utils.toBN(gasUsed));
        let ethPrice = web3.utils.fromWei(weiPrice, "ether");
        let usdPrice = web3.utils.fromWei(weiPrice.mul(web3.utils.toBN(ETH_USD_PRICE)), "ether");
        return `gas used ${gasUsed}, ${ethPrice} ETH, ${usdPrice} USD`;
    }
};