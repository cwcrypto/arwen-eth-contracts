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

    // Events
    event PuzzlePosted(bytes32 p);
    event EscrowClosed(EscrowCloseReason r);
    event Preimage(bytes32 i);

    enum EscrowState { UNFUNDED, OPEN, PUZZLE_POSTED }
    enum EscrowCloseReason { REFUND, PUZZLEREFUND, PUZZLESOLVE, CASHOUT }

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
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade,
        uint _timelock
    )
        internal
    {
        escrowReserve = _escrowReserve;
        escrowTrade = _escrowTrade;
        escrowRefund = _escrowRefund;
        payeeReserve = _payeeReserve;
        payeeTrade = _payeeTrade;
        escrowTimelock = _timelock;
    }

    /** Cashout the escrow sending the final balances after trading
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in OPEN state
    * @param _prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function cashout(
        uint _prevAmountTraded,
        bytes memory _eSig,
        bytes memory _pSig
    )
        public
        inState(EscrowState.OPEN)
    {
        bytes32 h = keccak256(abi.encodePacked(
            address(this),
            _prevAmountTraded
        ));

        // Check signatures
        require(verify(h, _eSig) == escrowTrade, "Invalid escrower cashout sig");
        require(verify(h, _pSig) == payeeTrade, "Invalid payee cashout sig");

        sendToPayee(_prevAmountTraded);
        sendRemainingToEscrower();
        closeEscrow(EscrowCloseReason.CASHOUT);
    }

    /** Allows the escrower to refund the escrow after the `escrowTimelock` has been reached
    * @dev Must be signed by the escrower refund key
    * @dev Must be in OPEN state
    * @param _prevAmountTraded The total amount traded to the payee in the
    * payment channel
    */
    function refund(
        uint _prevAmountTraded,
        bytes memory _eSig
    )
        public
        inState(EscrowState.OPEN)
        afterTimelock(escrowTimelock)
    {
        bytes32 h = keccak256(abi.encodePacked(
            address(this),
            _prevAmountTraded
        ));

        // Check signature
        require(verify(h, _eSig) == escrowRefund, "Invalid escrower sig");

        sendToPayee(_prevAmountTraded);
        sendRemainingToEscrower();
        closeEscrow(EscrowCloseReason.REFUND);
    }

    /** Post a hash puzzle unlocks lastest trade in the escrow 
    * @dev Must be signed by both the escrower and payee trade keys
    * @dev Must be in OPEN state
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
        inState(EscrowState.OPEN)
    {
        bytes32 h = keccak256(abi.encodePacked(
            address(this),
            _prevAmountTraded,
            _tradeAmount,
            _puzzle,
            _puzzleTimelock
        ));

        require(verify(h, eSig) == escrowTrade, "Invalid escrower sig");
        require(verify(h, pSig) == payeeTrade, "Invalid payee sig");

        // Save the puzzle parameters
        puzzle = _puzzle;
        puzzleTimelock = _puzzleTimelock;

        escrowState = EscrowState.PUZZLE_POSTED;
        emit PuzzlePosted(puzzle);

        // Return the previously traded funds
        sendToPayee(_prevAmountTraded);
        sendToEscrower(escrowAmount - _prevAmountTraded - _tradeAmount);
    }

    /**
    * Payee solves the hash puzzle redeeming the last trade amount of funds in the escrow
    * @dev Must be in PUZZLE_POSTED state
    * @param _preimage The preimage x such that H(x) == puzzle
    */
    function solvePuzzle(bytes32 _preimage)
        public
        inState(EscrowState.PUZZLE_POSTED)
    {
        bytes32 h = keccak256(abi.encodePacked(_preimage));
        require(h == puzzle, "Invalid preimage");

        emit Preimage(_preimage);
        sendRemainingToPayee();
        closeEscrow(EscrowCloseReason.PUZZLESOLVE);
    }

    /**
    * Escrower refunds the last trade amount after `puzzleTimelock` has been reached
    * @dev Must be in PUZZLE_POSTED state
    */
    function refundPuzzle()
        public
        inState(EscrowState.PUZZLE_POSTED)
        afterTimelock(puzzleTimelock)
    {
        sendRemainingToEscrower();
        closeEscrow(EscrowCloseReason.PUZZLEREFUND);
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
    function closeEscrow(EscrowCloseReason reason) internal;

    /**
    * Abstract methods that must be implemented by derived classes
    */
    function sendToEscrower(uint _amt) internal;
    function sendRemainingToEscrower() internal;
    function sendToPayee(uint _amt) internal;
    function sendRemainingToPayee() internal;

    function () external payable inState(EscrowState.UNFUNDED) {
    }

    function openEscrow() external inState(EscrowState.UNFUNDED){
        require(address(this).balance >= escrowAmount);

        if(address(this).balance > escrowAmount) {
            escrowReserve.send(address(this).balance - escrowAmount);
        }
        escrowState = EscrowState.OPEN;
    }
}


/** 
* @title CWC Escrow Contract backed by ETH
* @dev Implementation of a CWC unidirectional escrow payment channel using ETH directly
* @dev Escrow starts in the OPEN state because it is funded in the constructor
* by sending `escrowAmount` of ETH with the transaction
*/
contract EthEscrow is Escrow {

    uint public escrowerBalance;
    uint public payeeBalance;

    constructor(
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade,
        uint _escrowAmt,
        uint _timelock
    ) 
        public
    Escrow(
        _escrowReserve,
        _escrowTrade,
        _escrowRefund,
        _payeeReserve,
        _payeeTrade,
        _timelock
    )
    {
        escrowAmount = _escrowAmt;
        escrowState = EscrowState.UNFUNDED;
    }

     function closeEscrow(EscrowCloseReason reason) internal {
        
        emit EscrowClosed(reason);
        
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
* @dev Escrow starts in the UNFUNDED state and only moves to OPEN once the
* `fundEscrow` function is called which also transfers `escrowAmount` of tokens
* into this contract from a target address that has approved the transfer
*/
contract Erc20Escrow is Escrow {

    ERC20 public token;

    constructor(
        address _tknAddr,
        uint _tknAmt,
        address payable _escrowReserve,
        address _escrowTrade,
        address _escrowRefund,
        address payable _payeeReserve,
        address _payeeTrade,
        uint _timelock
    )
        public
        payable
    Escrow(
        _escrowReserve,
        _escrowTrade,
        _escrowRefund,
        _payeeReserve,
        _payeeTrade,
        _timelock
    )
    {
        escrowAmount = _tknAmt;
        
        // Validate the token address implements the ERC 20 standard
        token = ERC20(_tknAddr);
        // Start in UNFUNDED state until the fundEscrow function is called
        escrowState = EscrowState.UNFUNDED; // Start in an unfunded state
    }

    /**
    * Attempts to transfer escrowAmount into this contract
    * @dev Will fail unless the _from address has approved this contract to *
    * transfer at least `escrowAmount` using the `approve` method of the token
    * contract
    * @param _from The address to transfer the tokens from
    */
    function fundEscrow(address payable _from) public inState(EscrowState.UNFUNDED) {
        require(token.transferFrom(_from, address(this), escrowAmount));
        escrowState = EscrowState.OPEN;
    }

    function closeEscrow(EscrowCloseReason reason) internal {
        emit EscrowClosed(reason);
        
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