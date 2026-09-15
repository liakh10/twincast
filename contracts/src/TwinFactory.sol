// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TwinMath as M} from "./TwinMath.sol";
import {PoolKey, ModifyLiquidityParams, IPoolManager, IERC20R, Delta} from "./IV4.sol";
import {TwinToken} from "./TwinToken.sol";

interface ITwinRouterF {
    function buy(address token, uint256 minOut, address to) external payable returns (uint256);
}

/// @title Twincast factory and locker
/// Deployed with CREATE2 at the same address on Robinhood Chain and on Base. A launch creates the token with CREATE2
/// from keccak(launcher, salt), so the launcher gets the same token address on both chains and nobody else can take it.
/// All supply goes into two single-sided Uniswap v4 positions against native ETH owned by this contract: 800M on a
/// curve from about a 1 ETH to a 16 ETH market cap and 200M above it. There is no code path that removes liquidity.
/// The pool fee is 1%. ETH fees are split 50% to the token's fee wallet and 50% to the chain's protocol recipient,
/// fees paid in the token are burned. Chain-specific addresses are set once by `configure`; after that the owner has
/// no powers.
contract TwinFactory {
    uint256 public constant CURVE_TOKENS = 8e26;
    uint256 public constant RESERVE_TOKENS = 2e26;
    int24 public constant TICK_SPACING = 200;
    int24 public constant OPEN_TICK = 207200;
    int24 public constant CURVE_TICKS = 27800;
    int24 internal constant MAX_TICK_200 = 887200;
    uint24 public constant POOL_FEE = 10000;
    uint256 public constant CREATOR_SHARE_BPS = 5000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable owner;
    IPoolManager public poolManager;
    address public router;
    address public protocolRecipient;
    bool public configured;

    struct Launch {
        address token;
        address creator;
        address feeTo;
        uint64 createdAt;
        uint256 ethFees;
        uint256 tokenBurned;
    }

    Launch[] internal _launches;
    mapping(address => uint256) public launchIndex;
    mapping(address => uint256) public claimable;
    uint256 public totalEthFees;
    uint256 public protocolPaid;
    uint256 internal entered;

    event Configured(address poolManager, address router, address protocolRecipient);
    event TokenLaunched(address indexed token, address indexed creator, bytes32 salt, string name, string symbol, string metadataURI, uint256 devEth, uint256 devTokens);
    event FeesCollected(address indexed token, uint256 ethFees, uint256 toCreator, uint256 toProtocol, uint256 tokenBurned);
    event FeeToSet(address indexed token, address feeTo);
    event Claimed(address indexed account, uint256 amount);

    modifier nonReentrant() {
        require(entered == 0, "reentry");
        entered = 1;
        _;
        entered = 0;
    }

    /// `_owner` is the only constructor argument, so the creation code is identical on every chain.
    constructor(address _owner) {
        owner = _owner;
    }

    function configure(address _poolManager, address _router, address _protocolRecipient) external {
        require(msg.sender == owner, "owner");
        require(!configured, "configured");
        require(_poolManager != address(0) && _router != address(0) && _protocolRecipient != address(0), "zero");
        poolManager = IPoolManager(_poolManager);
        router = _router;
        protocolRecipient = _protocolRecipient;
        configured = true;
        emit Configured(_poolManager, _router, _protocolRecipient);
    }

    // ---------------------------------------------------------------- launch

    function saltOf(address launcher, bytes32 userSalt) public pure returns (bytes32) {
        return keccak256(abi.encode(launcher, userSalt));
    }

    /// Address a launch will get. The router address is part of the creation code, so it has to match across chains.
    function predictToken(address launcher, bytes32 userSalt, string calldata tokenName, string calldata symbol, string calldata uri) external view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(TwinToken).creationCode, abi.encode(tokenName, symbol, uri, router, launcher)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), saltOf(launcher, userSalt), codeHash)))));
    }

    /// Launches a token. Anything sent is a first buy for the launcher, guarded by `minOut`.
    function launch(string calldata tokenName, string calldata symbol, string calldata uri, bytes32 userSalt, uint256 minOut) external payable nonReentrant returns (address token, uint256 devTokens) {
        require(configured, "not configured");
        uint256 nl = bytes(tokenName).length;
        uint256 sl = bytes(symbol).length;
        require(nl >= 1 && nl <= 40 && sl >= 2 && sl <= 10 && bytes(uri).length <= 300, "text");

        token = address(new TwinToken{salt: saltOf(msg.sender, userSalt)}(tokenName, symbol, uri, router, msg.sender));
        int24 capTick = OPEN_TICK - CURVE_TICKS;
        PoolKey memory key = PoolKey(address(0), token, POOL_FEE, TICK_SPACING, address(0));
        poolManager.initialize(key, M.sqrtAtTick(OPEN_TICK));
        poolManager.unlock(abi.encode(uint8(0), key, capTick));

        uint256 left = IERC20R(token).balanceOf(address(this));
        if (left > 0) IERC20R(token).transfer(DEAD, left);

        _launches.push(Launch(token, msg.sender, msg.sender, uint64(block.timestamp), 0, 0));
        launchIndex[token] = _launches.length;

        if (msg.value > 0) devTokens = ITwinRouterF(router).buy{value: msg.value}(token, minOut, msg.sender);
        emit TokenLaunched(token, msg.sender, userSalt, tokenName, symbol, uri, msg.value, devTokens);
    }

    // ---------------------------------------------------------------- fees

    /// Collects the trading fees of a token. Anyone can call it.
    function collectFees(address token) external nonReentrant returns (uint256 ethFees, uint256 tokenFees) {
        uint256 idx = launchIndex[token];
        require(idx > 0, "token");
        Launch storage l = _launches[idx - 1];
        PoolKey memory key = PoolKey(address(0), token, POOL_FEE, TICK_SPACING, address(0));
        (ethFees, tokenFees) = abi.decode(poolManager.unlock(abi.encode(uint8(1), key, OPEN_TICK - CURVE_TICKS)), (uint256, uint256));
        uint256 toCreator = ethFees * CREATOR_SHARE_BPS / 10000;
        uint256 toProtocol = ethFees - toCreator;
        if (toCreator > 0) claimable[l.feeTo] += toCreator;
        if (toProtocol > 0) {
            (bool ok,) = protocolRecipient.call{value: toProtocol}("");
            if (!ok) claimable[protocolRecipient] += toProtocol;
            protocolPaid += toProtocol;
        }
        if (tokenFees > 0) _send(token, DEAD, tokenFees);
        l.ethFees += ethFees;
        l.tokenBurned += tokenFees;
        totalEthFees += ethFees;
        emit FeesCollected(token, ethFees, toCreator, toProtocol, tokenFees);
    }

    /// The launcher can send its future fee share to another wallet on this chain.
    function setFeeTo(address token, address feeTo) external {
        uint256 idx = launchIndex[token];
        require(idx > 0, "token");
        Launch storage l = _launches[idx - 1];
        require(msg.sender == l.creator, "creator");
        require(feeTo != address(0), "zero");
        l.feeTo = feeTo;
        emit FeeToSet(token, feeTo);
    }

    function claim() external nonReentrant returns (uint256) {
        return _pay(msg.sender);
    }

    function claimFor(address account) external nonReentrant returns (uint256) {
        return _pay(account);
    }

    function _pay(address account) internal returns (uint256 amount) {
        amount = claimable[account];
        if (amount == 0) return 0;
        claimable[account] = 0;
        (bool ok,) = account.call{value: amount}("");
        require(ok, "eth send");
        emit Claimed(account, amount);
    }

    receive() external payable {
        require(msg.sender == address(poolManager), "eth");
    }

    // ---------------------------------------------------------------- v4 callback

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "pool manager");
        (uint8 action, PoolKey memory key, int24 capTick) = abi.decode(data, (uint8, PoolKey, int24));
        address token = key.currency1;
        if (action == 0) {
            uint160 s = M.sqrtAtTick(OPEN_TICK);
            uint128 lc = M.liquidityFor(s, M.sqrtAtTick(capTick), s, 0, CURVE_TOKENS - 2);
            uint128 lr = M.liquidityFor(s, M.sqrtAtTick(-MAX_TICK_200), M.sqrtAtTick(capTick), 0, RESERVE_TOKENS - 2);
            (int256 d1,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(capTick, OPEN_TICK, int256(uint256(lc)), bytes32(0)), "");
            (int256 d2,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(-MAX_TICK_200, capTick, int256(uint256(lr)), bytes32(0)), "");
            int256 owed = int256(Delta.amount1(d1)) + Delta.amount1(d2);
            int256 other = int256(Delta.amount0(d1)) + Delta.amount0(d2);
            require(owed < 0 && other == 0, "single sided");
            poolManager.sync(token);
            _send(token, address(poolManager), uint256(-owed));
            poolManager.settle();
            return "";
        }
        (int256 e1,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(capTick, OPEN_TICK, 0, bytes32(0)), "");
        (int256 e2,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(-MAX_TICK_200, capTick, 0, bytes32(0)), "");
        int256 t0 = int256(Delta.amount0(e1)) + Delta.amount0(e2);
        int256 t1 = int256(Delta.amount1(e1)) + Delta.amount1(e2);
        uint256 f0 = t0 > 0 ? uint256(t0) : 0;
        uint256 f1 = t1 > 0 ? uint256(t1) : 0;
        if (f0 > 0) poolManager.take(address(0), address(this), f0);
        if (f1 > 0) poolManager.take(token, address(this), f1);
        return abi.encode(f0, f1);
    }

    // ---------------------------------------------------------------- views

    function launchCount() external view returns (uint256) {
        return _launches.length;
    }

    function launchOf(address token) external view returns (Launch memory l) {
        uint256 idx = launchIndex[token];
        if (idx > 0) l = _launches[idx - 1];
    }

    function launches(uint256 from, uint256 count) external view returns (Launch[] memory list) {
        uint256 n = _launches.length;
        if (from >= n) return new Launch[](0);
        uint256 end = from + count > n ? n : from + count;
        list = new Launch[](end - from);
        for (uint256 i = from; i < end; i++) list[i - from] = _launches[i];
    }

    function poolKeyOf(address token) external view returns (PoolKey memory) {
        require(launchIndex[token] > 0, "token");
        return PoolKey(address(0), token, POOL_FEE, TICK_SPACING, address(0));
    }

    function _send(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer");
    }
}
