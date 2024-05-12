/* eslint-disable camelcase */
/* eslint-disable no-console, import/order */
import Web3 from 'web3'
import { ZeroAddress } from 'ethers'

import networkConfig from '@/networkConfig'
import { cachedEventsLength, eventsType, httpConfig } from '@/constants'

import MulticallABI from '@/abis/Multicall.json'
import InstanceABI from '@/abis/Instance.abi.json'
import TornadoProxyABI from '@/abis/TornadoProxy.abi.json'

import { graph, treesInterface, EventsFactory } from '@/services'

import {
  randomBN,
  parseNote,
  toFixedHex,
  saveAsFile,
  isEmptyArray,
  parseHexNote,
  checkCommitments,
  buffPedersenHash
} from '@/utils'

import { buildGroth16, download, getTornadoKeys } from './snark'

let groth16

const websnarkUtils = require('@tornado/websnark/src/utils')
const { toWei, numberToHex, toBN, isAddress } = require('web3-utils')

const getStatisticStore = (acc, { tokens }) => {
  Object.entries(tokens).forEach(([currency, { instanceAddress }]) => {
    acc[currency] = Object.assign({}, acc[currency])

    Object.keys(instanceAddress).forEach((amount) => {
      if (!acc[currency][amount]) {
        acc[currency][amount] = {
          latestDeposits: [],
          nextDepositIndex: null,
          anonymitySet: null
        }
      }
    })
  })
  return acc
}

const defaultStatistics = Object.values(networkConfig).reduce(getStatisticStore, {})

const state = () => {
  return {
    note: null,
    commitment: null,
    prefix: null,
    notes: {},
    statistic: defaultStatistics,
    ip: {},
    selectedInstance: { currency: 'eth', amount: 0.1 },
    selectedStatistic: { currency: 'eth', amount: 0.1 },
    withdrawType: 'relayer',
    ethToReceive: '20000000000000000',
    defaultEthToReceive: '20000000000000000',
    withdrawNote: ''
  }
}

const mutations = {
  SAVE_DEPOSIT(state, { note, commitment, prefix }) {
    state.note = note
    state.commitment = commitment
    state.prefix = prefix
  },
  SAVE_PROOF(state, { proof, args, note }) {
    this._vm.$set(state.notes, note, { proof, args })
  },
  REMOVE_PROOF(state, { note }) {
    this._vm.$delete(state.notes, note)
  },
  SAVE_LAST_INDEX(state, { nextDepositIndex, anonymitySet, currency, amount }) {
    const currentState = state.statistic[currency][amount]
    this._vm.$set(state.statistic[currency], `${amount}`, { ...currentState, nextDepositIndex, anonymitySet })
  },
  SAVE_LAST_EVENTS(state, { latestDeposits, currency, amount }) {
    const currentState = state.statistic[currency][amount]
    this._vm.$set(state.statistic[currency], `${amount}`, { ...currentState, latestDeposits })
  },
  SET_SELECTED_INSTANCE(state, selectedInstance) {
    state.selectedInstance = selectedInstance
  },
  SET_SELECTED_STATISTIC(state, selectedStatistic) {
    state.selectedStatistic = selectedStatistic
  },
  SET_WITHDRAW_TYPE(state, { withdrawType }) {
    this._vm.$set(state, 'withdrawType', withdrawType)
  },
  SAVE_ETH_TO_RECEIVE(state, { ethToReceive }) {
    this._vm.$set(state, 'ethToReceive', ethToReceive)
  },
  SAVE_DEFAULT_ETH_TO_RECEIVE(state, { ethToReceive }) {
    this._vm.$set(state, 'defaultEthToReceive', ethToReceive)
  },
  SET_WITHDRAW_NOTE(state, withdrawNote) {
    state.withdrawNote = withdrawNote
  }
}

const getters = {
  getWeb3: (state, getters, rootState, rootGetters) => {
    const netId = rootGetters['metamask/netId']
    const { url } = rootState.settings[`netId${netId}`].rpc
    const httpProvider = new Web3.providers.HttpProvider(url, httpConfig)
    return new Web3(httpProvider)
  },
  eventsInterface: (state, getters, rootState, rootGetters) => {
    const netId = rootGetters['metamask/netId']
    const { url } = rootState.settings[`netId${netId}`].rpc
    return new EventsFactory(url)
  },
  instanceContract: (state, getters) => ({ currency, amount, netId }) => {
    const config = networkConfig[`netId${netId}`]
    const address = config.tokens[currency].instanceAddress[amount]
    const web3 = getters.getWeb3
    return new web3.eth.Contract(InstanceABI, address)
  },
  multicallContract: (state, getters) => ({ netId }) => {
    const config = networkConfig[`netId${netId}`]
    const web3 = getters.getWeb3
    return new web3.eth.Contract(MulticallABI, config.multicall)
  },
  tornadoProxyContract: (state, getters) => ({ netId }) => {
    const {
      'tornado-proxy.contract.tornadocash.eth': tornadoProxy,
      'tornado-router.contract.tornadocash.eth': tornadoRouter,
      'tornado-proxy-light.contract.tornadocash.eth': tornadoProxyLight
    } = networkConfig[`netId${netId}`]

    const proxyContract = tornadoRouter || tornadoProxy || tornadoProxyLight
    const web3 = getters.getWeb3
    return new web3.eth.Contract(TornadoProxyABI, proxyContract)
  },
  currentContract: (state, getters) => (params) => {
    return getters.tornadoProxyContract(params)
  },
  relayerWithdrawalTxData: (state, getters, rootState, rootGetters) => ({
    proof,
    withdrawCallArgs,
    currency,
    amount
  }) => {
    const netId = rootGetters['metamask/netId']
    const tornadoProxy = getters.tornadoProxyContract({ netId })
    const tornadoInstance = getters.instanceContract({ currency, amount, netId })

    const { withdrawType } = state
    const relayer = rootState.relayer.selectedRelayer.address
    const { ethAccount } = rootState.metamask

    const calldata = tornadoProxy.methods
      .withdraw(tornadoInstance._address, proof, ...withdrawCallArgs)
      .encodeABI()

    return {
      from: withdrawType === 'relayer' ? relayer : ethAccount,
      to: tornadoProxy._address,
      data: calldata,
      value: withdrawCallArgs[5] || 0
    }
  },
  ethToReceiveInToken: (state, getters, rootState, rootGetters) => {
    const { currency } = rootState.application.selectedStatistic
    const { decimals } = rootGetters['metamask/networkConfig'].tokens[currency]
    const price = rootState.price.prices[currency]
    const ethToReceive = toBN(state.ethToReceive)
    return ethToReceive.mul(toBN(10 ** decimals)).div(toBN(price))
  },
  isNotEnoughTokens: (state, getters, rootState, rootGetters) => {
    const { amount, currency } = rootState.application.selectedStatistic
    let total = toBN(rootGetters['token/fromDecimals'](amount.toString()))

    if (state.withdrawType === 'relayer') {
      const relayerFee = rootState.fees.withdrawalFeeViaRelayer
      const nativeCurrency = rootGetters['metamask/nativeCurrency']

      if (currency === nativeCurrency) {
        total = total.sub(relayerFee)
      } else {
        const ethToReceiveInToken = getters.ethToReceiveInToken
        total = total.sub(relayerFee).sub(ethToReceiveInToken)
      }
    }

    return total.isNeg()
  },
  maxEthToReceive: (state, getters, rootState, rootGetters) => {
    const { currency, amount } = rootState.application.selectedStatistic
    const { decimals } = rootGetters['metamask/networkConfig'].tokens[currency]
    const total = toBN(rootGetters['token/fromDecimals'](amount.toString()))
    const price = rootState.price.prices[currency]
    return total
      .sub(rootState.fees.withdrawalFeeViaRelayer)
      .mul(toBN(price))
      .div(toBN(10 ** decimals))
  },
  selectedCurrency: (state, getters, rootState, rootGetters) => {
    const tokens = rootGetters['metamask/networkConfig'].tokens
    return tokens[state.selectedInstance.currency].symbol
  },
  selectedStatisticCurrency: (state, getters, rootState, rootGetters) => {
    const tokens = rootGetters['metamask/networkConfig'].tokens
    return tokens[state.selectedStatistic.currency].symbol
  },
  lastEventIndex: (state) => ({ currency, amount }) => {
    return state.statistic[currency][amount].anonymitySet
  },
  latestDeposits: (state) => {
    const { currency, amount } = state.selectedStatistic
    return state.statistic[currency][amount].latestDeposits
  },
  hasEnabledLightProxy: (state, getters, rootState, rootGetters) => {
    return Boolean(rootGetters['metamask/networkConfig']['tornado-proxy-light.contract.tornadocash.eth'])
  },
  isOptimismConnected: (state, getters, rootState, rootGetters) => {
    const netId = rootGetters['metamask/netId']
    return Number(netId) === 10
  },
  isArbitrumConnected: (state, getters, rootState, rootGetters) => {
    const netId = rootGetters['metamask/netId']
    return Number(netId) === 42161
  }
}

const actions = {
  setAndUpdateStatistic({ dispatch, commit }, { currency, amount }) {
    commit('SET_SELECTED_STATISTIC', { currency, amount })

    dispatch('updateSelectEvents')
  },
  async updateSelectEvents({ dispatch, commit, state, rootGetters, getters }) {
    const netId = rootGetters['metamask/netId']
    const { currency, amount } = state.selectedStatistic

    const eventService = getters.eventsInterface.getService({ netId, amount, currency })
    const graphEvents = await eventService.getEventsFromGraph({ methodName: 'getStatistic' })

    let statistic = graphEvents?.events

    const latestDeposits = []

    if (!statistic || !statistic.length) {
      statistic = []
    }

    const { nextDepositIndex, anonymitySet } = await dispatch('getLastDepositIndex', {
      currency,
      amount,
      netId
    })

    statistic = statistic.sort((a, b) => a.leafIndex - b.leafIndex)

    for (const event of statistic.slice(-10)) {
      latestDeposits.unshift({
        index: event.leafIndex,
        depositTime: this.$moment.unix(event.timestamp).fromNow()
      })
    }

    commit('SAVE_LAST_EVENTS', {
      amount,
      currency,
      latestDeposits
    })
    commit('SAVE_LAST_INDEX', {
      amount,
      currency,
      anonymitySet,
      nextDepositIndex
    })
  },
  async updateEvents({ getters, rootGetters }, payload) {
    try {
      const eventService = getters.eventsInterface.getService(payload)

      const freshEvents = await eventService.updateEvents(payload.type)

      return freshEvents
    } catch (err) {
      throw new Error(`Method updateEvents has error: ${err.message}`)
    }
  },
  async updateCurrentEvents({ dispatch, rootGetters }, { amount, currency, lastEvent, type, netId }) {
    let lastBlock = lastEvent
    const nativeCurrency = rootGetters['metamask/nativeCurrency']
    const { deployedBlock } = networkConfig[`netId${netId}`]

    if (currency === nativeCurrency && !lastEvent) {
      lastBlock = await this.$indexedDB(netId).getFromIndex({
        indexName: 'name',
        storeName: 'lastEvents',
        key: `${type}s_${netId}_${currency}_${amount}`
      })
    }

    const params = {
      type,
      netId,
      amount,
      currency,
      fromBlock: lastBlock ? lastBlock.blockNumber + 1 : deployedBlock
    }

    const events = await dispatch('updateEvents', params)

    return events
  },
  async getLastDepositIndex({ getters }, params) {
    try {
      const contractInstance = getters.instanceContract(params)
      const nextDepositIndex = await contractInstance.methods.nextIndex().call()

      return {
        nextDepositIndex,
        anonymitySet: toBN(nextDepositIndex)
      }
    } catch (err) {
      throw new Error(`Method getLastDepositIndex has error: ${err.message}`)
    }
  },
  async loadEncryptedEvents(_, { netId }) {
    try {
      const module = await download({
        contentType: 'string',
        name: `events/encrypted_notes_${netId}.json.gz`
      })

      if (module) {
        const events = JSON.parse(module)

        return {
          events,
          lastBlock: events[events.length - 1].blockNumber
        }
      }
    } catch (err) {
      throw new Error(`Method loadCachedEvents has error: ${err.message}`)
    }
  },
  prepareDeposit({ getters, dispatch, commit, rootGetters }, { prefix }) {
    try {
      const [, currency, amount, netId] = prefix.split('-')
      const contractInstance = getters.instanceContract({ currency, amount, netId })

      const secret = randomBN(31)
      const nullifier = randomBN(31)

      const preimage = Buffer.concat([nullifier.toBuffer('le', 31), secret.toBuffer('le', 31)])

      const commitment = buffPedersenHash(preimage)
      const commitmentHex = toFixedHex(commitment)

      const note = `0x${preimage.toString('hex')}`

      const isEnabled = rootGetters['encryptedNote/isEnabledSaveFile']

      if (isEnabled) {
        setTimeout(() => {
          try {
            dispatch('saveFile', { prefix, note })
          } catch (err) {
            console.warn('NoteAccount backup as a file is not supported on this device', err)
          }
        }, 1000)
      }

      commit('SAVE_DEPOSIT', { note, commitment: commitmentHex, prefix })
      if (!contractInstance._address) {
        throw new Error(this.app.i18n.t('networkIsNotSupported'))
      }
    } catch (e) {
      console.error('prepareDeposit', e)
    }
  },
  saveFile(_, { prefix, note }) {
    try {
      const data = new Blob([`${prefix}-${note}`], { type: 'text/plain;charset=utf-8' })

      saveAsFile(data, `backup-${prefix}-${note.slice(0, 10)}.txt`)
    } catch (err) {
      console.error('saveFile', err.message)
    }
  },
  async getEncryptedEventsFromDb(_, { netId }) {
    try {
      const idb = this.$indexedDB(netId)

      if (idb.isBlocked) {
        return []
      }

      const cachedEvents = await idb.getAll({ storeName: 'encrypted_events' })

      return cachedEvents
    } catch (err) {
      console.warn(`Method getEventsFromDb has error: ${err.message}`)
    }
  },
  async getEncryptedNotes({ rootState, rootGetters, dispatch, getters }) {
    try {
      const { netId } = rootState.metamask
      const rpc = rootGetters['settings/currentRpc']
      let { ENCRYPTED_NOTES_BLOCK: deployedBlock } = networkConfig[`netId${netId}`].constants

      const contractInstance = getters.tornadoProxyContract({ netId })

      let cachedEvents = await dispatch('getEncryptedEventsFromDb', { netId })

      const networksWithCache = {
        1: cachedEventsLength.mainnet.ENCRYPTED_NOTES,
        56: cachedEventsLength.bsc.ENCRYPTED_NOTES
      }

      const LENGTH_CACHE = networksWithCache[Number(netId)]

      if (
        ((isEmptyArray(cachedEvents) || !cachedEvents) && networksWithCache[Number(netId)]) ||
        cachedEvents.length < LENGTH_CACHE
      ) {
        ;({ events: cachedEvents } = await dispatch('loadEncryptedEvents', { netId }))
      }

      const hasCache = Boolean(cachedEvents && cachedEvents.length)

      if (hasCache) {
        const [lastEvent] = cachedEvents.sort((a, b) => a.blockNumber - b.blockNumber).slice(-1)

        deployedBlock = lastEvent.blockNumber + 1
      }

      const web3 = this.$provider.getWeb3(rpc.url)
      const currentBlockNumber = await web3.eth.getBlockNumber()

      let events = []

      const { events: graphEvents, lastSyncBlock } = await graph.getAllEncryptedNotes({
        netId,
        fromBlock: deployedBlock
      })

      if (lastSyncBlock) {
        deployedBlock = lastSyncBlock
      }

      const blockDifference = Math.ceil(currentBlockNumber - deployedBlock)
      const divisor = hasCache ? 2 : 10

      let blockRange = blockDifference > divisor ? blockDifference / divisor : blockDifference

      if (Number(netId) === 56) {
        blockRange = 4950
      }

      let numberParts = blockDifference === 0 ? 1 : Math.ceil(blockDifference / blockRange)
      const part = Math.ceil(blockDifference / numberParts)

      let fromBlock = deployedBlock
      let toBlock = deployedBlock + part

      if (toBlock >= currentBlockNumber || toBlock === deployedBlock) {
        toBlock = 'latest'
        numberParts = 1
      }

      for (let i = 0; i < numberParts; i++) {
        const partOfEvents = await contractInstance.getPastEvents('EncryptedNote', {
          toBlock,
          fromBlock
        })
        if (partOfEvents) {
          events = events.concat(partOfEvents)
        }
        fromBlock = toBlock
        toBlock += part
      }

      if (events && events.length) {
        events = events
          .filter((i) => i.returnValues.encryptedNote)
          .map((e) => ({
            txHash: e.transactionHash,
            transactionHash: e.transactionHash,
            blockNumber: Number(e.blockNumber),
            encryptedNote: e.returnValues.encryptedNote
          }))
      }

      const allEvents = [].concat(cachedEvents, graphEvents, events)

      await dispatch('saveEncryptedEventsToDB', { events: allEvents, netId })

      return allEvents
    } catch (err) {
      console.log('getEncryptedNotes', err)
    }
  },
  async saveEncryptedEventsToDB(_, { events, netId }) {
    const idb = this.$indexedDB(netId)

    if (!events || !events.length || idb.isBlocked) {
      return
    }

    await idb.createMultipleTransactions({
      data: events,
      storeName: `encrypted_events`
    })
  },
  async sendDeposit({ state, rootState, getters, rootGetters, dispatch, commit }, { isEncrypted }) {
    try {
      const web3 = getters.getWeb3
      const { commitment, note, prefix } = state
      // eslint-disable-next-line prefer-const
      let [, currency, amount, netId] = prefix.split('-')
      const config = networkConfig[`netId${netId}`]
      const contractInstance = getters.tornadoProxyContract({ netId })

      if (!state.commitment) {
        throw new Error(this.app.i18n.t('failToGenerateNote'))
      }

      const { nextDepositIndex: index } = await dispatch('getLastDepositIndex', { netId, currency, amount })

      const { ethAccount } = rootState.metamask
      const nativeCurrency = rootGetters['metamask/nativeCurrency']
      const isNative = currency === nativeCurrency

      const value = isNative ? toWei(amount, 'ether') : '0'
      const instance = config.tokens[currency].instanceAddress[amount]

      let params = [instance, commitment, []]

      if (isEncrypted) {
        const encryptedNote = await dispatch(
          'encryptedNote/getEncryptedNote',
          { data: `${instance}-${note}` },
          { root: true }
        )

        params = [instance, commitment, encryptedNote]
      }

      const data = contractInstance.methods.deposit(...params).encodeABI()
      const incompletedTx = {
        from: ethAccount,
        to: contractInstance._address,
        value: numberToHex(value),
        data
      }
      const gasLimit = Math.floor((await web3.eth.estimateGas(incompletedTx)) * 1.2)

      const callParams = {
        method: 'eth_sendTransaction',
        params: Object.assign({ gas: numberToHex(gasLimit) }, incompletedTx),
        watcherParams: {
          title: { path: 'depositing', amount, currency },
          successTitle: {
            path: 'depositedValue',
            amount,
            currency
          },
          storeType: isEncrypted ? 'encryptedTxs' : 'txs'
        },
        isAwait: false
      }

      const txHash = await dispatch('metamask/sendTransaction', callParams, { root: true })

      // there may be a race condition, you need to request an index and a timestamp of the deposit after tx is mined
      const timestamp = Math.round(new Date().getTime() / 1000)

      const { nullifierHex, commitmentHex } = parseHexNote(state.note)
      const storeType = isEncrypted ? 'encryptedTxs' : 'txs'

      const accounts = rootGetters['encryptedNote/accounts']

      const tx = {
        txHash,
        type: 'Deposit',
        note,
        amount,
        storeType,
        prefix,
        netId,
        timestamp,
        index,
        nullifierHex,
        commitmentHex,
        currency
      }
      console.log('tx', tx)

      if (isEncrypted) {
        tx.note = params[2]
        tx.owner = isAddress(accounts.encrypt) ? accounts.encrypt : ''
        tx.backupAccount = isAddress(accounts.backup) ? accounts.backup : ''
      }

      commit('txHashKeeper/SAVE_TX_HASH', tx, { root: true })
    } catch (e) {
      console.error('sendDeposit', e)
      return false
    }
  },
  async checkSpentEventFromNullifier({ getters, dispatch }, parsedNote) {
    try {
      const isSpent = await dispatch('loadEvent', {
        note: parsedNote,
        eventName: 'nullifierHash',
        type: eventsType.WITHDRAWAL,
        methodName: 'getAllWithdrawals',
        eventToFind: parsedNote.nullifierHex
      })

      return Boolean(isSpent)
    } catch (err) {
      console.error(`Method checkSpentEventFromNullifier has error: ${err.message}`)
    }
  },
  async checkRoot({ getters }, { root, parsedNote }) {
    const contractInstance = getters.instanceContract(parsedNote)

    const isKnownRoot = await contractInstance.methods.isKnownRoot(root).call()

    if (!isKnownRoot) {
      throw new Error(this.app.i18n.t('invalidRoot'))
    }
  },
  async buildTree({ dispatch }, { currency, amount, netId, commitmentHex }) {
    const treeInstanceName = `${netId}_${currency}_${amount}`
    const params = { netId, amount, currency }

    const treeService = treesInterface.getService({
      ...params,
      commitment: commitmentHex,
      instanceName: treeInstanceName
    })

    const [cachedTree, eventsData] = await Promise.all([
      treeService.getTree(),
      dispatch('updateEvents', { ...params, type: eventsType.DEPOSIT })
    ])

    const commitments = eventsData.events.map((el) => el.commitment.toString(10))

    let tree = cachedTree
    if (tree) {
      const newLeaves = commitments.slice(tree.elements.length)
      tree.bulkInsert(newLeaves)
    } else {
      console.log('events', eventsData)
      checkCommitments(eventsData.events)
      tree = treeService.createTree({ events: commitments })
    }

    const root = toFixedHex(tree.root)
    await dispatch('checkRoot', { root, parsedNote: params })

    await treeService.saveTree({ tree })

    return { tree, root }
  },
  async createSnarkProof(
    { rootGetters, rootState, state, getters, dispatch },
    { root, note, tree, recipient, leafIndex }
  ) {
    const { circuit, provingKey } = await getTornadoKeys()

    if (!groth16) {
      groth16 = await buildGroth16()
    }

    const web3 = getters.getWeb3

    const { nullifierHash, secret, nullifier, amount, currency } = note

    const { denomination, isNativeCurrency } = rootGetters['fees/selectedInstance']
    const withdrawType = state.withdrawType

    const { pathElements, pathIndices } = tree.path(leafIndex)
    console.log('pathElements, pathIndices', pathElements, pathIndices)

    const defaultGasLimit = rootGetters['fees/gasLimit']()
    let gasLimit = defaultGasLimit

    async function getProof() {
      let relayer = ZeroAddress
      let fee = BigInt(0)
      let refund = BigInt(0)

      if (withdrawType === 'relayer') {
        // Recalculate proof with actual fee and refund
        await dispatch(
          'fees/calculateWithdrawalFeeViaRelayer',
          {
            tx: {
              gasLimit
            }
          },
          { root: true }
        )

        relayer = rootState.relayer.selectedRelayer.address
        fee = BigInt(rootState.fees.withdrawalFeeViaRelayer)

        if (fee > denomination) {
          throw new Error(
            'Relayer fee exceeds the withdraw amount, disable relayer withdrawal or use other amount'
          )
        }
      }

      if (!isNativeCurrency) {
        refund = rootGetters['fees/ethRefund']
      }

      const input = {
        // public
        fee,
        root,
        refund,
        relayer: BigInt(relayer),
        recipient: BigInt(recipient),
        nullifierHash,
        // private
        pathIndices,
        pathElements,
        secret,
        nullifier
      }

      console.log('Start generating SNARK proof', input)
      console.time('SNARK proof time')
      const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, provingKey)
      const { proof } = websnarkUtils.toSolidityInput(proofData)

      const args = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
        toFixedHex(input.relayer, 20),
        toFixedHex(input.fee),
        toFixedHex(input.refund)
      ]
      console.timeEnd('SNARK proof time')

      return {
        relayer,
        fee,
        proof,
        args
      }
    }

    // eslint-disable-next-line prefer-const
    let { proof, args } = await getProof()

    const withdrawalTx = getters.relayerWithdrawalTxData({
      proof,
      withdrawCallArgs: args,
      amount,
      currency
    })

    gasLimit = BigInt(await web3.eth.estimateGas(withdrawalTx))

    // If required gasLimit is above default, calculate the snark proof again
    if (gasLimit > defaultGasLimit) {
      ;({ proof, args } = await getProof())

      const withdrawalTx = getters.relayerWithdrawalTxData({
        proof,
        withdrawCallArgs: args,
        amount,
        currency
      })
      gasLimit = BigInt(await web3.eth.estimateGas(withdrawalTx))
    }

    return { proof, args }
  },
  async prepareWithdraw({ dispatch, commit }, { note, recipient }) {
    commit('REMOVE_PROOF', { note })
    try {
      const parsedNote = parseNote(note)

      const { tree, root } = await dispatch('buildTree', parsedNote)

      const isSpent = await dispatch('checkSpentEventFromNullifier', parsedNote)

      if (isSpent) {
        throw new Error(this.app.i18n.t('noteHasBeenSpent'))
      }

      const { proof, args } = await dispatch('createSnarkProof', {
        root,
        tree,
        recipient,
        note: parsedNote,
        leafIndex: tree.indexOf(parsedNote.commitmentHex)
      })
      commit('SAVE_PROOF', { proof, args, note })
    } catch (e) {
      console.error('prepareWithdraw', e)
      throw new Error(e.message)
    }
  },
  async withdraw({ state, rootState, rootGetters, dispatch, getters }, { note }) {
    try {
      const web3 = getters.getWeb3
      const [, currency, amount, netId] = note.split('-')
      const config = networkConfig[`netId${netId}`]
      const { proof, args } = state.notes[note]
      const { ethAccount } = rootState.metamask

      const contractInstance = getters.tornadoProxyContract({ netId })

      const instance = config.tokens[currency].instanceAddress[amount]
      const params = [instance, proof, ...args]

      const data = contractInstance.methods.withdraw(...params).encodeABI()
      const incompletedTx = {
        data,
        value: args[5],
        to: contractInstance._address,
        from: ethAccount
      }
      const gasLimit = Math.floor((await web3.eth.estimateGas(incompletedTx)) * 1.1)

      const callParams = {
        method: 'eth_sendTransaction',
        params: Object.assign({ gas: numberToHex(gasLimit) }, incompletedTx),
        watcherParams: {
          title: { path: 'withdrawing', amount, currency },
          successTitle: {
            amount,
            currency,
            path: 'withdrawnValue'
          },
          onSuccess: (txHash) => {
            dispatch('txHashKeeper/updateDeposit', { amount, currency, netId, note, txHash }, { root: true })
          }
        },
        isAwait: false,
        isSaving: false
      }

      await dispatch('metamask/sendTransaction', callParams, { root: true })
    } catch (e) {
      console.error(e)
      throw new Error(e.message)
    }
  },
  loadAllNotesData({ dispatch, rootGetters }) {
    const { tokens } = rootGetters['metamask/networkConfig']

    for (const [currency, { instanceAddress }] of Object.entries(tokens)) {
      for (const amount in instanceAddress) {
        if (instanceAddress[amount]) {
          dispatch('updateLastIndex', { currency, amount })
        }
      }
    }
  },
  async updateLastIndex({ dispatch, commit, rootState }, { currency, amount }) {
    const netId = rootState.metamask.netId
    const { nextDepositIndex, anonymitySet } = await dispatch('getLastDepositIndex', {
      currency,
      netId,
      amount
    })

    commit('SAVE_LAST_INDEX', {
      amount,
      currency,
      anonymitySet,
      nextDepositIndex
    })
  },
  async loadEvent({ getters, rootGetters }, { note, type, eventName, eventToFind }) {
    try {
      const eventService = getters.eventsInterface.getService(note)

      const foundEvent = await eventService.findEvent({ eventName, eventToFind, type })

      return foundEvent
    } catch (err) {
      console.error(`Method loadEvent has error: ${err.message}`)
    }
  },
  async loadDepositEvent({ state, dispatch }, { withdrawNote }) {
    try {
      const note = parseNote(withdrawNote)

      const lastEvent = await dispatch('loadEvent', {
        note,
        eventName: 'commitment',
        type: eventsType.DEPOSIT,
        methodName: 'getAllDeposits',
        eventToFind: note.commitmentHex
      })

      if (lastEvent) {
        const { nextDepositIndex } = state.statistic[note.currency][note.amount]
        const depositsPast = nextDepositIndex - lastEvent.leafIndex - 1

        const isSpent = await dispatch('checkSpentEventFromNullifier', note)

        return {
          isSpent,
          depositsPast,
          timestamp: lastEvent.timestamp,
          leafIndex: lastEvent.leafIndex,
          txHash: lastEvent.transactionHash,
          depositBlock: lastEvent.blockNumber
        }
      }
    } catch (err) {
      console.error(`Method loadDepositEvent has error: ${err.message}`)
    }
  },
  async loadWithdrawalEvent({ dispatch }, { withdrawNote }) {
    try {
      const note = parseNote(withdrawNote)

      const lastEvent = await dispatch('loadEvent', {
        note,
        eventName: 'nullifierHash',
        type: eventsType.WITHDRAWAL,
        methodName: 'getAllWithdrawals',
        eventToFind: note.nullifierHex
      })

      if (lastEvent) {
        return {
          to: lastEvent.to,
          fee: lastEvent.fee,
          txHash: lastEvent.transactionHash,
          blockNumber: lastEvent.blockNumber
        }
      }
    } catch (err) {
      console.error(`Method loadWithdrawalEvent has error: ${err.message}`)
    }
  },
  async loadWithdrawalData({ commit, dispatch, rootGetters }, { withdrawNote }) {
    try {
      const toDecimals = rootGetters['token/toDecimals']

      const { currency, amount } = parseNote(withdrawNote)
      const { fee, txHash, blockNumber, to } = await dispatch('loadWithdrawalEvent', { withdrawNote })

      const decimals = rootGetters['metamask/networkConfig'].tokens[currency].decimals
      const withdrawalAmount = toBN(rootGetters['token/fromDecimals'](amount.toString(), decimals)).sub(
        toBN(fee)
      )

      return {
        to,
        txHash,
        withdrawalBlock: blockNumber,
        fee: toDecimals(fee, decimals, 4),
        amount: toDecimals(withdrawalAmount, decimals, 4)
      }
    } catch (e) {
      console.error(`Method loadWithdrawalData has error: ${e}`)
    }
  },
  setDefaultEthToReceive({ commit, rootGetters }, { gasPrice, refundGasLimit }) {
    const ethToReceive = rootGetters['fees/oracle'].defaultEthRefund(gasPrice, refundGasLimit).toString()
    commit('SAVE_ETH_TO_RECEIVE', { ethToReceive })
    commit('SAVE_DEFAULT_ETH_TO_RECEIVE', { ethToReceive })
  },
  setNativeCurrency({ commit }, { netId }) {
    const currency = networkConfig[`netId${netId}`].nativeCurrency
    const amounts = Object.keys(networkConfig[`netId${netId}`].tokens[currency].instanceAddress)
    const amount = Math.min(...amounts)

    commit('SET_SELECTED_INSTANCE', { currency, amount })
    commit('SET_SELECTED_STATISTIC', { currency, amount })
  },
  async aggregateMulticall({ rootGetters, getters }, { params }) {
    try {
      const netId = rootGetters['metamask/netId']
      const multicallContract = getters.multicallContract({ netId })

      const result = await multicallContract.methods.aggregate(params).call()

      return result.returnData
    } catch (err) {
      console.log('err', err.message)
    }
  }
}
export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
