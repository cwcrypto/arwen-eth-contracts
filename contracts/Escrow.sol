pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";


/**
* @title CWC Escrow Contract
* @dev Implementation of a CWC unidirectional escrow payment channel
* @dev Abstract contract with methods that must be implemented for either ETH
* or ERC20 tokens in derived contracts
*/
contract Escrow {

    enum EscrowState {
        Unfunded,
        Open,
        PuzzlePosted
    }

    enum EscrowCloseReason {
        Refund,
        PuzzleRefund,
        PuzzleSolve,
        Cashout
    }

    // Events
    event EscrowOpened();
    event PuzzlePosted(bytes32 puzzle);
    event EscrowClosed(EscrowCloseReason reason, bytes32 sighash);
    event Preimage(bytes32 preimage);

    /** Immutable State (only set once in constructor) */
    address payable escrowReserve;
    address escrowTrade;
    address escrowRefund;

    address payable payeeReserve;
    address payeeTrade;

    uint public escrowAmount;
    uint public escrowTimelock;

    /** Mutable state */
    EscrowState public escrowState;
    bytes32 public puzzleSighash;
    bytes32 public puzzle;
    uint public puzzleTimelock;

    /** Modifiers */
    modifier inState(EscrowState _state) {
        require(escrowState == _state, "Invalid escrow state");
        _;
    }

    modifier afterTimelock(uint _timelock) {
        require(now >= _timelock, "Timelock not reached");
        _;
    }

    constructor(
        uint _escrowAmt,
        uint _timelock,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade
    )
        internal
    {
        escrowAmount = _escrowAmt;
        escrowTimelock = _timelock;
        escrowReserve = _escrowReserve;
        escrowTrade = _escrowTrade;
        escrowRefund = _escrowRefund;
        payeeReserve = _payeeReserve;
        payeeTrade = _payeeTrade;
    }

    /** Cashout the escrow sending the final balances after trading
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in Open state
    * @param _prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function cashout(
        uint _prevAmountTraded,
        bytes memory _eSig,
        bytes memory _pSig
    )
        public
        inState(EscrowState.Open)
    {
        bytes32 sighash = keccak256(abi.encodePacked(
            address(this),
            _prevAmountTraded
        ));

        // Check signatures
        require(verify(sighash, _eSig) == escrowTrade, "Invalid escrower cashout sig");
        require(verify(sighash, _pSig) == payeeTrade, "Invalid payee cashout sig");

        sendToPayee(_prevAmountTraded);
        sendRemainingToEscrower();
        closeEscrow(EscrowCloseReason.Cashout, sighash);
    }

    /** Allows the escrower to refund the escrow after the `escrowTimelock` has been reached
    * @dev Must be signed by the escrower refund key
    * @dev Must be in Open state
    * @param _prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function refund(
        uint _prevAmountTraded,
        bytes memory _eSig
    )
        public
        inState(EscrowState.Open)
        afterTimelock(escrowTimelock)
    {
        bytes32 sighash = keccak256(abi.encodePacked(
            address(this),
            _prevAmountTraded
        ));

        // Check signature
        require(verify(sighash, _eSig) == escrowRefund, "Invalid escrower sig");

        sendToPayee(_prevAmountTraded);
        sendRemainingToEscrower();
        closeEscrow(EscrowCloseReason.Refund, sighash);
    }

    /** Post a hash puzzle unlocks lastest trade in the escrow
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in Open state
    * @param _prevAmountTraded The total amount traded to the payee in the
    * payment channel before the last trade
    * @param _tradeAmount The current trade amount
    * @param _puzzle A hash puzzle where the solution (preimage) releases the
    * `_tradeAmount` to the payee
    * @param  _puzzleTimelock The time at which the `_tradeAmount` can be
    * refunded back to the escrower if the puzzle solution is not posted
    */
    function postPuzzle(
        uint _prevAmountTraded,
        uint _tradeAmount,
        bytes32 _puzzle,
        uint _puzzleTimelock,
        bytes memory eSig,
        bytes memory pSig
    )
        public
        inState(EscrowState.Open)
    {
        bytes32 sighash = keccak256(abi.encodePacked(
            address(this),
            _prevAmountTraded,
            _tradeAmount,
            _puzzle,
            _puzzleTimelock
        ));

        require(verify(sighash, eSig) == escrowTrade, "Invalid escrower sig");
        require(verify(sighash, pSig) == payeeTrade, "Invalid payee sig");

        // Save the puzzle parameters
        puzzle = _puzzle;
        puzzleTimelock = _puzzleTimelock;
        puzzleSighash = sighash;

        escrowState = EscrowState.PuzzlePosted;
        emit PuzzlePosted(puzzle);

        // Return the previously traded funds
        sendToPayee(_prevAmountTraded);
        sendToEscrower(escrowAmount - _prevAmountTraded - _tradeAmount);
    }

    /**
    * Payee solves the hash puzzle redeeming the last trade amount of funds in the escrow
    * @dev Must be in PuzzlePosted state
    * @param _preimage The preimage x such that H(x) == puzzle
    */
    function solvePuzzle(bytes32 _preimage)
        public
        inState(EscrowState.PuzzlePosted)
    {
        bytes32 h = keccak256(abi.encodePacked(_preimage));
        require(h == puzzle, "Invalid preimage");

        emit Preimage(_preimage);
        sendRemainingToPayee();
        closeEscrow(EscrowCloseReason.PuzzleSolve, puzzleSighash);
    }

    /**
    * Escrower refunds the last trade amount after `puzzleTimelock` has been reached
    * @dev Must be in PuzzlePosted state
    */
    function refundPuzzle()
        public
        inState(EscrowState.PuzzlePosted)
        afterTimelock(puzzleTimelock)
    {
        sendRemainingToEscrower();
        closeEscrow(EscrowCloseReason.PuzzleRefund, puzzleSighash);
    }

    /** Verify a EC signature (v,r,s) on a message digest h
    * Uses EIP-191 for ethereum signed messages
    * @return retAddr The recovered address from the signature or 0 if signature is invalid
    */
    function verify( bytes32 _h, bytes memory sig) internal pure returns(address retAddr) {
        bytes32 prefixedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _h));
        retAddr = ECDSA.recover(prefixedHash, sig);
    }

    /**
    * Moves escrow state to CLOSED and emits an event log that the escrow has been closed
    */
    function closeEscrow(EscrowCloseReason reason, bytes32 sighash) internal;

    /**
    * Abstract methods that must be implemented by derived classes
    */
    function sendToEscrower(uint _amt) internal;
    function sendRemainingToEscrower() internal;
    function sendToPayee(uint _amt) internal;
    function sendRemainingToPayee() internal;
}


/**
* @title CWC Escrow Contract backed by ETH
* @dev Implementation of a CWC unidirectional escrow payment channel using ETH directly
* @dev Escrow starts in the Open state because it is funded in the constructor
* by sending `escrowAmount` of ETH with the transaction
*/
contract EthEscrow is Escrow {

    event EscrowFunded(uint amountFunded);

    uint public escrowerBalance;
    uint public payeeBalance;

    constructor(
        uint _escrowAmt,
        uint _timelock,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade
    )
    public
    Escrow(
        _escrowAmt,
        _timelock,
        _escrowReserve,
        _escrowTrade,
        _escrowRefund,
        _payeeReserve,
        _payeeTrade
    )
    {
    }

    function () external payable inState(EscrowState.Unfunded) {
        emit EscrowFunded(address(this).balance);
    }

    function openEscrow() public inState(EscrowState.Unfunded) {
        require(address(this).balance >= escrowAmount, "Escrow not funded");

        if(address(this).balance > escrowAmount) {
            escrowReserve.send(address(this).balance - escrowAmount);
        }
        escrowState = EscrowState.Open;
        emit EscrowOpened();
    }

    function closeEscrow(EscrowCloseReason reason, bytes32 sighash) internal {
        emit EscrowClosed(reason, sighash);

        // Below we use send rather than transfer because we do not want to have an exception throw
        // Regardless of who is mallicious, all remianing funds will be self-destrcuted
        // the escrower
        escrowReserve.send(escrowerBalance);
        payeeReserve.send(payeeBalance);
        selfdestruct(escrowReserve);
    }

    function sendToEscrower(uint _amt) internal {
        escrowerBalance += _amt;
    }

    function sendRemainingToEscrower() internal {
        escrowerBalance += address(this).balance - payeeBalance - escrowerBalance;
    }

    function sendToPayee(uint _amt) internal {
        payeeBalance += _amt;
    }

    function sendRemainingToPayee() internal {
        payeeBalance += address(this).balance - payeeBalance - escrowerBalance;
    }
}


/**
* @title CWC Escrow Contract backed by a ERC20 token
* @dev Implementation of a CWC unidirectional escrow payment channel using an arbitrary ERC20 token
* @dev Escrow starts in the Unfunded state and only moves to Open once the
* `fundEscrow` function is called which also transfers `escrowAmount` of tokens
* into this contract from a target address that has approved the transfer
*/
contract Erc20Escrow is Escrow {

    ERC20 public token;

    constructor(
        address _tknAddr,
        uint _tknAmt,
        uint _timelock,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade
    )
        public
        payable
    Escrow(
        _tknAmt,
        _timelock,
        _escrowReserve,
        _escrowTrade,
        _escrowRefund,
        _payeeReserve,
        _payeeTrade
    )
    {
        // Validate the token address implements the ERC 20 standard
        token = ERC20(_tknAddr);
        // Start in Unfunded state until the fundEscrow function is called
        escrowState = EscrowState.Unfunded; // Start in an unfunded state
    }

    /**
    * Attempts to transfer escrowAmount into this contract
    * @dev Will fail unless the _from address has approved this contract to
    * transfer at least `escrowAmount` using the `approve` method of the token
    * contract
    * @param _from The address to transfer the tokens from
    */
    function fundEscrow(address payable _from) public inState(EscrowState.Unfunded) {
        require(token.transferFrom(_from, address(this), escrowAmount), "Token Transfer failed");
        escrowState = EscrowState.Open;
        emit EscrowOpened();
    }

    function closeEscrow(EscrowCloseReason reason, bytes32 sighash) internal {
        emit EscrowClosed(reason, sighash);

        // If either party is mallicious, all remaining funds are transfered to the escrower regardless of what happens
        selfdestruct(escrowReserve);
    }

    function sendToEscrower(uint _amt) internal {
        token.transfer(escrowReserve, _amt);
    }

    function sendRemainingToEscrower() internal {
        token.transfer(escrowReserve, token.balanceOf(address(this)));
    }

    function sendToPayee(uint _amt) internal {
        token.transfer(payeeReserve, _amt);
    }

    function sendRemainingToPayee() internal {
        token.transfer(payeeReserve, token.balanceOf(address(this)));
    }
}