// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Twincast token
/// Deployed by the Twincast factory with CREATE2. Nothing in its creation code depends on the chain, so the same
/// launcher, salt, name, ticker and metadata give the same address on every chain the factory lives on. Fixed 1B
/// supply per chain, minted to the factory, which puts all of it into permanent Uniswap v4 liquidity. The Twincast
/// router moves tokens without an allowance, so selling takes one transaction.
contract TwinToken {
    uint256 public constant totalSupply = 1e27;
    uint8 public constant decimals = 18;

    string public name;
    string public symbol;
    string public metadataURI;
    address public immutable factory;
    address public immutable router;
    address public immutable creator;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, string memory _uri, address _router, address _creator) {
        factory = msg.sender;
        router = _router;
        creator = _creator;
        name = _name;
        symbol = _symbol;
        metadataURI = _uri;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (msg.sender != router) {
            uint256 a = allowance[from][msg.sender];
            if (a != type(uint256).max) {
                require(a >= amount, "allowance");
                allowance[from][msg.sender] = a - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "to");
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        unchecked { balanceOf[from] = b - amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
