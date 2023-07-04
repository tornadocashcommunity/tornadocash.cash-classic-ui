// Imports

import BN from 'bignumber.js'
import { EthereumProvider } from '@walletconnect/ethereum-provider'
import networkConfig, { enabledChains } from '@/networkConfig'

// Build an array of the first RPC URL for each network in a reduce
const createRpcMapIterator = (accumulator, chainId) => {
  // Get RPCs urls
  const { rpcUrls } = networkConfig[`netId${chainId}`]

  // Choose for each network the first rpc's url
  const [{ url }] = Object.values(rpcUrls)

  // Append and continue
  return { ...accumulator, [chainId]: url }
}

// const walletConnectInterval = 1000 // TODO: Check if we still need
const reconnectInterval = 3600000 // 1 hour
const supportedWallets = ['metamask', 'trust', 'imtoken', 'genericWeb3']
const rpcMap = enabledChains.reduce(createRpcMapIterator, {})

const walletConnectConnector = async (chainId) => {
  try {
    const prevConnection = localStorage.getItem('walletconnectTimeStamp')

    if (new BN(Date.now()).minus(prevConnection).isGreaterThanOrEqualTo(reconnectInterval)) {
      localStorage.removeItem('walletconnect')
    }

    const optionalChains = enabledChains.filter((chain) => chain !== chainId)

    const provider = await EthereumProvider.init({
      projectId: process.env.WC_PROJECT_ID,
      relayUrl: process.env.WC_BRIDGE,
      chains: [chainId],
      optionalChains,
      rpcMap,
      methods: [
        'eth_sendTransaction',
        'personal_sign',
        'eth_signTypedData_v4',
        'eth_getEncryptionPublicKey',
        'eth_decrypt',
        'eth_getBalance',
        'eth_getTransactionReceipt',
        'eth_accounts',
        'eth_chainId',
        'wallet_addEthereumChain',
        'wallet_switchEthereumChain'
      ],
      showQrModal: true,
      qrModalOptions: {
        mobileWallets: supportedWallets
      }
    })

    provider.injectedRequest = provider.enable

    localStorage.setItem('walletconnectTimeStamp', Date.now())

    return provider
  } catch (err) {
    console.error(err)
    throw new Error('WalletConnectConnector error: ', err)
  }
}

export default walletConnectConnector
