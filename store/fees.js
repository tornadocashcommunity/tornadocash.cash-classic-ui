/* eslint-disable no-console */
import { toWei, toBN } from 'web3-utils'
import { formatUnits, parseUnits } from 'ethers'
import { ChainId, TornadoFeeOracle, getProvider } from '@tornado/tornado-oracles'
import { WITHDRAW_GAS_LIMIT } from '@/constants/variables'

export const state = () => {
  return {
    gasPriceParams: { gasPrice: toWei(toBN(50), 'gwei') },
    l1Fee: toBN(0),
    withdrawalNetworkFee: toBN(0),
    withdrawalFeeViaRelayer: toBN(0)
  }
}

export const getters = {
  provider: (state, getters, rootState, rootGetters) => {
    const netId = Number(rootGetters['metamask/netId'])
    const { url: rpcUrl } = rootState.settings[`netId${netId}`].rpc
    const config = rootGetters['metamask/networkConfig']

    return getProvider(netId, rpcUrl, config)
  },
  oracle: (state, getters, rootState, rootGetters) => {
    const netId = Number(rootGetters['metamask/netId'])
    const { url: rpcUrl } = rootState.settings[`netId${netId}`].rpc
    const config = rootGetters['metamask/networkConfig']

    return new TornadoFeeOracle(netId, rpcUrl, config)
  },
  getGasPriceParams: (state) => {
    return state.gasPriceParams
  },
  getMetamaskGasPriceParams: (state) => {
    const feeData = state.gasPriceParams

    const gasParams = feeData.maxFeePerGas
      ? {
          maxFeePerGas: '0x' + feeData.maxFeePerGas.toString(16),
          maxPriorityFeePerGas: '0x' + feeData.maxPriorityFeePerGas.toString(16)
        }
      : {
          gasPrice: '0x' + feeData.gasPrice.toString(16)
        }

    return gasParams
  },
  l1Fee: (state) => {
    return state.l1Fee
  },
  selectedInstance: (state, getters, rootState, rootGetters) => {
    const nativeCurrency = rootGetters['metamask/nativeCurrency']
    const { tokens } = rootGetters['metamask/networkConfig']
    const { currency, amount } = rootState.application.selectedStatistic

    const {
      instanceAddress: instanceAddresses,
      decimals,
      gasLimit: instanceGasLimit,
      tokenGasLimit
    } = tokens[currency]

    const { [amount]: instanceAddress } = instanceAddresses

    const isNativeCurrency = currency.toLowerCase() === nativeCurrency

    const firstAmount = Object.keys(instanceAddresses).sort((a, b) => Number(a) - Number(b))[0]
    const isFirstAmount = Number(amount) === Number(firstAmount)

    const denomination = parseUnits(String(amount), decimals)

    const tokenPriceInWei = rootState.price.prices[currency.toLowerCase()]

    return {
      instanceAddress,
      currency: currency.toLowerCase(),
      amount: String(amount),
      decimals,
      denomination,
      isNativeCurrency,
      isFirstAmount,
      instanceGasLimit,
      tokenGasLimit,
      tokenPriceInWei
    }
  },
  gasPrice: (state, getters, rootState, rootGetters) => {
    const netId = Number(rootGetters['metamask/netId'])
    const gasPriceParams = getters.getGasPriceParams

    let gasPrice = BigInt(
      gasPriceParams.maxFeePerGas
        ? gasPriceParams.maxFeePerGas.toString()
        : gasPriceParams.gasPrice.toString()
    )

    // to-do: manually bump gas price for BSC, remove this when we are able to check gasPrice from relayer status
    if (netId === ChainId.BSC && gasPrice < parseUnits('3.3', 'gwei')) {
      gasPrice = parseUnits('3.3', 'gwei')
    }

    return gasPrice
  },
  gasPriceInGwei: (state, getters) => {
    return formatUnits(getters.gasPrice, 'gwei')
  },
  gasLimit: (state, getters) => ({ gas, gasLimit } = {}) => {
    const { instanceGasLimit } = getters.selectedInstance
    return BigInt(gas || gasLimit || instanceGasLimit || WITHDRAW_GAS_LIMIT)
  },
  refundGasLimit: (state, getters) => {
    const { isFirstAmount, tokenGasLimit } = getters.selectedInstance
    return isFirstAmount && tokenGasLimit ? BigInt(tokenGasLimit) : undefined
  },
  ethRefund: (state, getters, rootState) => {
    return rootState.application.ethToReceive || 0
  },
  relayerFeePercent: (state, getters, rootState) => {
    return rootState.relayer.selectedRelayer.tornadoServiceFee
  }
}

export const mutations = {
  SAVE_GAS_PARAMS(state, payload) {
    state.gasPriceParams = payload
  },
  SAVE_WITHDRAWAL_NETWORK_FEE(state, gasFee) {
    state.withdrawalNetworkFee = gasFee
  },
  SAVE_WITHDRAWAL_FEE_VIA_RELAYER(state, fee) {
    state.withdrawalFeeViaRelayer = fee
  },
  SAVE_L1_FEE(state, fee) {
    state.l1Fee = fee
  }
}

export const actions = {
  async fetchGasPrice({ getters, dispatch, commit, rootGetters }) {
    const { pollInterval } = rootGetters['metamask/networkConfig']

    try {
      const feeData = await getters.provider.getFeeData()

      const gasParams = feeData.maxFeePerGas
        ? {
            maxFeePerGas: feeData.maxFeePerGas.toString(),
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
              ? feeData.maxPriorityFeePerGas.toString()
              : null
          }
        : {
            gasPrice: feeData.gasPrice ? feeData.gasPrice.toString() : parseUnits('50', 'gwei').toString()
          }

      commit('SAVE_GAS_PARAMS', gasParams)
    } catch (e) {
      console.error('fetchGasPrice', e)
    } finally {
      setTimeout(() => dispatch('fetchGasPrice'), 2000 * pollInterval)
    }
  },
  setDefaultGasPrice({ commit, rootGetters }) {
    const { gasPrices } = rootGetters['metamask/networkConfig']
    commit('SAVE_GAS_PARAMS', { gasPrice: toWei(gasPrices?.fast?.toFixed(9) || 0, 'gwei') })
  },
  calculateWithdrawalNetworkFee({ getters, commit }, { tx }) {
    const gasPrice = getters.gasPrice
    const gasLimit = BigInt(tx?.gas || tx?.gasLimit || WITHDRAW_GAS_LIMIT)

    const gasCost = gasPrice * gasLimit

    commit('SAVE_WITHDRAWAL_NETWORK_FEE', toBN(gasCost.toString()))

    return gasCost
  },
  async calculateL1Fee({ commit, getters }, { tx }) {
    const oracle = getters.oracle

    const l1Fee = await oracle.fetchL1OptimismFee(tx)

    commit('SAVE_L1_FEE', toBN(l1Fee.toString()))
  },
  async calculateWithdrawalFeeViaRelayer({ dispatch, getters, commit }, { tx }) {
    const { decimals, denomination, isNativeCurrency, tokenPriceInWei } = getters.selectedInstance

    const oracle = getters.oracle
    const gasPrice = getters.gasPrice
    const gasLimit = getters.gasLimit(tx)
    const refundGasLimit = getters.refundGasLimit
    const relayerFeePercent = getters.relayerFeePercent

    await dispatch('calculateL1Fee', { tx })
    dispatch('calculateWithdrawalNetworkFee', { tx })

    const l1Fee = getters.l1Fee

    if (!isNativeCurrency) {
      dispatch('application/setDefaultEthToReceive', { gasPrice, refundGasLimit }, { root: true })

      const ethRefund = getters.ethRefund

      const relayerFee = oracle.calculateRelayerFee({
        gasPrice,
        gasLimit,
        l1Fee,
        denomination,
        ethRefund,
        tokenPriceInWei,
        tokenDecimals: decimals,
        relayerFeePercent,
        isEth: isNativeCurrency
      })

      commit('SAVE_WITHDRAWAL_FEE_VIA_RELAYER', toBN(relayerFee.toString()))
      return
    }

    const relayerFee = oracle.calculateRelayerFee({
      gasPrice,
      gasLimit,
      l1Fee,
      denomination,
      relayerFeePercent
    })

    commit('SAVE_WITHDRAWAL_FEE_VIA_RELAYER', toBN(relayerFee.toString()))
  }
}
