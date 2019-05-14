import { Account, Sign } from "web3-eth-accounts";
import { TransactionReceipt } from "web3-core";

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
     */

    signCashout(addr: string, amountTraded: number): DuoSigned {
        var types = ['address', 'uint256'];
        var values = [addr, amountTraded];
        var message = web3.eth.abi.encodeParameters(types, values);
        var digest = web3.utils.keccak256(message);
        return {
            eSig: this.eTrade.sign(digest),
            pSig: this.pTrade.sign(digest)
        };
    }

    signEscrowRefund(addr: string, amountTraded: number): Sign {
        var types = ['address', 'uint256'];
        var values = [addr, amountTraded];
        var message = web3.eth.abi.encodeParameters(types, values);
        var digest = web3.utils.keccak256(message);
        return this.eRefund.sign(digest);
    }

    signPuzzle(addr: string, prevAmountTraded: number, tradeAmt: number, puzzle: string, timelock: number): DuoSigned {
        var types = ['address', 'uint256', 'uint256', 'bytes32', 'uint256'];
        var values = [addr, prevAmountTraded, tradeAmt, puzzle, timelock];
        var message = web3.eth.abi.encodeParameters(types, values);
        var digest = web3.utils.keccak256(message);
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
        const ETH_USD_Price = 207;

        let ethPrice = web3.utils.fromWei(GAS_PRICE.mul(web3.utils.toBN(gasUsed)), "ether");
        let usdPrice = ethPrice * ETH_USD_Price;
        return `gas used ${gasUsed}, ${ethPrice} ETH, ${usdPrice} USD`;
    }
};