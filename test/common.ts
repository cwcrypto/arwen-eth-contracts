import { Account, Sign } from "web3-eth-accounts";
import { TransactionReceipt } from "web3-core";
import Web3 from "web3";

/**
 * Escrow state enum matching the Escrow.sol internal state machine
 */
export enum EscrowState { UNFUNDED, OPEN, PUZZLE_POSTED, CLOSED }


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
     * Sign methods will automatically add the message prefix
     * "\x19Ethereum Signed Message:\n" + message.length
     * https://web3js.readthedocs.io/en/1.0/web3-eth-accounts.html#sign
     * 
     * We use SoliditySha3 since we want our message to be packed.
     * SoliditySha3 will automatically run encodePacked before 
     * hashing. SoliditySha3(encodePacked())
     * https://web3js.readthedocs.io/en/1.0/web3-utils.html#soliditysha3
     */
    signCashout(addr: string, amountTraded: number): DuoSigned {
        var digest = web3.utils.soliditySha3({t: "address", v: addr}, {t: "uint256", v: amountTraded});
        return {
            eSig: this.eTrade.sign(digest),
            pSig: this.pTrade.sign(digest)
        };
    }

    signEscrowRefund(addr: string, amountTraded: number): Sign {
        var digest = web3.utils.soliditySha3({t: "address", v: addr}, {t: "uint256", v: amountTraded});
        return this.eRefund.sign(digest);
    }

    signPuzzle(addr: string, prevAmountTraded: number, tradeAmt: number, puzzle: string, timelock: number): DuoSigned {
        var digest = web3.utils.soliditySha3({t: "address", v: addr}, {t: "uint256", v: prevAmountTraded}, 
        {t: "uint256", v: tradeAmt}, {t: "bytes32", v: puzzle}, {t: "uint256", v: timelock});
        return {
            eSig: this.eTrade.sign(digest),
            pSig: this.pTrade.sign(digest)
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