// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TwinMath as M} from "./TwinMath.sol";
import {PoolKey, SwapParams, IPoolManager, Delta} from "./IV4.sol";

interface ITwinFactoryR {
    function poolManager() external view returns (IPoolManager);
    function poolKeyOf(address token) external view returns (PoolKey memory);
}

/// @title Twincast router
/// Buys and sells Twincast tokens for native ETH in one transaction through the Uniswap v4 PoolManager. Its only
/// constructor argument is the factory, which has the same address on every chain, so the router does too.
/// Sells need no approval: Twincast tokens let this router move the caller's own tokens. `minOut` guards both sides.
contract TwinRouter {
    ITwinFactoryR public immutable factory;

    uint8 internal constant BUY = 0;
    uint8 internal constant SELL = 1;

    event Buy(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut);
    event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 ethOut);

    constructor(address _factory) {
        factory = ITwinFactoryR(_factory);
    }

    function buy(address token, uint256 minOut, address to) external payable returns (uint256 out) {
        require(msg.value > 0, "zero");
        out = abi.decode(factory.poolManager().unlock(abi.encode(BUY, token, msg.value, minOut, msg.sender, to)), (uint256));
        emit Buy(token, to, msg.value, out);
    }

    function sell(address token, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out) {
        require(amountIn > 0, "zero");
        out = abi.decode(factory.poolManager().unlock(abi.encode(SELL, token, amountIn, minOut, msg.sender, to)), (uint256));
        emit Sell(token, msg.sender, amountIn, out);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        IPoolManager pm = factory.poolManager();
        require(msg.sender == address(pm), "pool manager");
        (uint8 kind, address token, uint256 amountIn, uint256 minOut, address payer, address to) = abi.decode(data, (uint8, address, uint256, uint256, address, address));
        PoolKey memory key = factory.poolKeyOf(token);
        bool zeroForOne = kind == BUY;
        int256 d = pm.swap(key, SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? M.MIN_SQRT + 1 : M.MAX_SQRT - 1), "");
        int128 spent = zeroForOne ? Delta.amount0(d) : Delta.amount1(d);
        int128 got = zeroForOne ? Delta.amount1(d) : Delta.amount0(d);
        require(-int256(spent) == int256(amountIn) && got > 0, "partial fill");
        uint256 out = uint256(int256(got));
        require(out >= minOut, "min out");
        if (zeroForOne) {
            pm.settle{value: amountIn}();
            pm.take(token, to, out);
        } else {
            pm.sync(token);
            (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, payer, address(pm), amountIn));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transferFrom");
            pm.settle();
            pm.take(address(0), to, out);
        }
        return abi.encode(out);
    }
}
