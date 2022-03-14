const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { toFixedHex } = require('../src/utils')

const Utxo = require('../src/utxo')
const { transaction, prepareTransaction } = require('../src/index')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

describe('Custom ZKU Test', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')

    // merkle tree mechanism

    const hasher = await deploy('Hasher')
    const merkleTreeWithHistory = await deploy(
      'MerkleTreeWithHistoryMock',
      MERKLE_TREE_HEIGHT,
      hasher.address,
    )
    await merkleTreeWithHistory.initialize()

    // l1-l2 bridge mechanism

    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    return { tornadoPool, token, proxy, omniBridge, amb, gov, multisig, hasher, merkleTreeWithHistory }
  }

  describe('zku q3.2.2', () => {
    it('should print gas estimate, deposit eth, withdraw eth, and assert balances are correct', async () => {
      const { tornadoPool, token, omniBridge, merkleTreeWithHistory } = await loadFixture(fixture)
      
      /*
       * estimate gas of addling leaves to merkle tree
       */

      const L1 = toFixedHex(1);
      const L2 = toFixedHex(2);
      const gas = await merkleTreeWithHistory.estimateGas.insert(L1, L2)
      console.log('Gas estimate', gas - 21000)

      /* 
       * bridge tokens from l1 to l2
       */

      const alonKeypair = new Keypair() // contains private and public keys
  
      // Alon deposits into tornado pool
      const alonDepositAmount = utils.parseEther('0.08')
      const alonDepositUtxo = new Utxo({ amount: alonDepositAmount, keypair: alonKeypair })
      const { args, extData } = await prepareTransaction({
        tornadoPool,
        outputs: [alonDepositUtxo],
      })
  
      const onTokenBridgedData = encodeDataForBridge({
        proof: args,
        extData,
      })
  
      const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
        token.address,
        alonDepositUtxo.amount,
        onTokenBridgedData,
      )
      // emulating bridge. first it sends tokens to omnibridge mock then it sends to the pool
      await token.transfer(omniBridge.address, alonDepositAmount)
      const transferTx = await token.populateTransaction.transfer(tornadoPool.address, alonDepositAmount)
  
      await omniBridge.execute([
        { who: token.address, callData: transferTx.data }, // send tokens to pool
        { who: tornadoPool.address, callData: onTokenBridgedTx.data }, // call onTokenBridgedTx
      ])
  
      // withdraws a part of his funds from the shielded pool
      const alonWithdrawAmount = utils.parseEther('0.05')
      const recipient = '0xDeaD00000000000000000000000000000000BEEf'
      const alonChangeUtxo = new Utxo({
        amount: alonDepositAmount.sub(alonWithdrawAmount),
        keypair: alonKeypair,
      })
      await transaction({
        tornadoPool,
        inputs: [alonDepositUtxo],
        outputs: [alonChangeUtxo],
        recipient: recipient,
        isL1Withdrawal: true,
      })
  
      const recipientBalance = await token.balanceOf(recipient)
      expect(recipientBalance).to.be.equal(0)
      console.log("Recipient Balance: ", recipientBalance.toString())
      const omniBridgeBalance = await token.balanceOf(omniBridge.address)
      expect(omniBridgeBalance).to.be.equal(aliceWithdrawAmount)
      console.log("omniBridge Balance: ", omniBridgeBalance.toString())
      const tornadoPoolBal = await token.balanceOf(tornadoPool.address)
      expect(tornadoPoolBal).to.be.equal(alonChangeUtxo.amount)
      console.log("tornadoPool Balance: ", tornadoPoolBal.toString())
    })
  })
})
