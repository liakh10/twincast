// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20R} from "./IV4.sol";

/// @title Twincast buyback
/// Receives the protocol share of every Robinhood Chain launch's trading fees in ETH. The keeper spends it on $TWIN through an allowed
/// swap contract (the Uniswap Universal Router, or the Pons curve before $TWIN graduates) and every $TWIN this
/// contract holds is sent to the dead address in the same transaction. ETH can leave only through an allowed target,
/// and the call has to bring back at least `minOut` $TWIN. There is no withdraw function.
contract TwinBuyback {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public owner;
    address public pendingOwner;
    address public keeper;
    address public twin;
    mapping(address => bool) public allowedTarget;

    uint256 public totalReceived;
    uint256 public totalEthSpent;
    uint256 public totalBurned;

    event Received(address indexed from, uint256 amount);
    event BoughtBack(address indexed target, uint256 ethIn, uint256 twinOut);
    event Burned(uint256 amount);
    event TwinSet(address token);
    event TargetSet(address indexed target, bool allowed);
    event KeeperSet(address keeper);
    event OwnershipTransferred(address indexed previous, address indexed next);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        keeper = msg.sender;
    }

    receive() external payable {
        totalReceived += msg.value;
        emit Received(msg.sender, msg.value);
    }

    /// Spends `ethIn` through `target` and burns all $TWIN held afterwards.
    function buyBack(address target, bytes calldata data, uint256 ethIn, uint256 minOut) external returns (uint256 got) {
        require(msg.sender == keeper || msg.sender == owner, "keeper");
        require(twin != address(0) && allowedTarget[target], "target");
        require(ethIn > 0 && ethIn <= address(this).balance, "balance");
        uint256 before = IERC20R(twin).balanceOf(address(this));
        uint256 ethBefore = address(this).balance;
        (bool ok, bytes memory ret) = target.call{value: ethIn}(data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        }
        uint256 spent = ethBefore - address(this).balance;
        require(spent <= ethIn, "overspent");
        got = IERC20R(twin).balanceOf(address(this)) - before;
        require(got > 0 && got >= minOut, "min out");
        totalEthSpent += spent;
        emit BoughtBack(target, spent, got);
        _burn();
    }

    /// Sends any $TWIN sitting here to the dead address. Anyone can call it.
    function burn() external {
        _burn();
    }

    function _burn() internal {
        uint256 b = IERC20R(twin).balanceOf(address(this));
        if (b == 0) return;
        require(IERC20R(twin).transfer(DEAD, b), "burn");
        totalBurned += b;
        emit Burned(b);
    }

    function setTwin(address token) external onlyOwner {
        require(twin == address(0) && token != address(0), "set");
        twin = token;
        emit TwinSet(token);
    }

    function setTarget(address target, bool allowed) external onlyOwner {
        require(target != twin, "token");
        allowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    function setKeeper(address next) external onlyOwner {
        keeper = next;
        emit KeeperSet(next);
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "pending");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
