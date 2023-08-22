/* eslint-disable no-console */
import { toWei, fromWei, toBN } from 'web3-utils'
import { TornadoFeeOracleV4, TornadoFeeOracleV5 } from '@tornado/tornado-oracles'

export const state = () => {
  return {
    gasPriceParams: { gasPrice: toWei(toBN(50), 'gwei') },
    withdrawalNetworkFee: toBN(0)
  }
}

export const getters = {
  oracle: (state, getters, rootState, rootGetters) => {
    const netId = Number(rootGetters['metamask/netId'])
    const { url: rpcUrl } = rootState.settings[`netId${netId}`].rpc
    const { gasPrices } = rootGetters['metamask/networkConfig']

    // Return old oracle for backwards compatibility, if chain is ETH Mainnet
    return netId === 1
      ? new TornadoFeeOracleV4(netId, rpcUrl, gasPrices)
      : new TornadoFeeOracleV5(netId, rpcUrl, gasPrices)
  },
  getGasPriceParams: (state) => {
    return state.gasPriceParams
  },
  gasPrice: (state, getters) => {
    const { gasPrice, maxFeePerGas } = getters.getGasPriceParams
    return maxFeePerGas || gasPrice
  },
  gasPriceInGwei: (state, getters) => {
    return fromWei(getters.gasPrice, 'gwei')
  }
}

export const mutations = {
  SAVE_GAS_PARAMS(state, payload) {
    state.gasPriceParams = payload
  },
  SAVE_WITHDRAWAL_NETWORK_FEE(state, gasFee) {
    state.withdrawalNetworkFee = gasFee
  }
}

export const actions = {
  async fetchGasPrice({ getters, dispatch, commit, rootGetters }) {
    const { pollInterval } = rootGetters['metamask/networkConfig']

    try {
      const gasPriceParams = await getters.oracle.getGasPriceParams()
      console.log(gasPriceParams)

      commit('SAVE_GAS_PARAMS', gasPriceParams)
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
  async calculateWithdrawalNetworkFee({ getters, commit }, { tx }) {
    const withdrawalGas = await getters.oracle.getGas(tx, 'user_withdrawal')

    commit('SAVE_WITHDRAWAL_NETWORK_FEE', toBN(withdrawalGas))
  }
}
