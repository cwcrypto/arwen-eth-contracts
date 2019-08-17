import { Account, Sign } from "web3-eth-accounts";
import { TransactionReceipt } from "web3-core";
import Web3 from "web3";

import * as encodeUtils from "./web3js-includes/Encodepacked";

/**
 * Escrow state enum matching the Escrow.sol internal state machine
 */
export enum EscrowState {
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

interface DuoSigned { eSig: Sign, pSig: Sign };

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

    signEscrowRefund(addr: string, amountTraded: number): Sign {
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
        // For up-to-date gas prices see: https://ethgasstation.info/
        const GAS_PRICE = web3.utils.toBN(2 * 1000 * 1000 * 1000); // 2 Gwei
        const ETH_USD_Price = 260;

        let ethPrice = web3.utils.fromWei(GAS_PRICE.mul(web3.utils.toBN(gasUsed)), "ether");
        let usdPrice = ethPrice * ETH_USD_Price;
        return `gas used ${gasUsed}, ${ethPrice} ETH, ${usdPrice} USD`;
    }
};