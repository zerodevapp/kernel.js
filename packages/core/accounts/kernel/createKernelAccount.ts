import { getAccountNonce, getSenderAddress } from "permissionless"
import {
    SignTransactionNotSupportedBySmartAccount,
    type SmartAccount
} from "permissionless/accounts"
import {
    type Address,
    type Chain,
    type Client,
    type EncodeDeployDataParameters,
    type Hex,
    type Transport,
    concatHex,
    encodeDeployData,
    encodeFunctionData,
    parseAbi
} from "viem"
import { toAccount } from "viem/accounts"
import { getBytecode, signMessage, signTypedData } from "viem/actions"
import type { KernelPlugin } from "../../types/kernel"
import { KernelExecuteAbi, KernelInitAbi } from "./abi/KernelAccountAbi.js"

export type KernelSmartAccount<
    transport extends Transport = Transport,
    chain extends Chain | undefined = Chain | undefined
> = SmartAccount<"kernelSmartAccount", transport, chain>

/**
 * The account creation ABI for a kernel smart account (from the KernelFactory)
 */
const createAccountAbi = [
    {
        inputs: [
            {
                internalType: "address",
                name: "_implementation",
                type: "address"
            },
            {
                internalType: "bytes",
                name: "_data",
                type: "bytes"
            },
            {
                internalType: "uint256",
                name: "_index",
                type: "uint256"
            }
        ],
        name: "createAccount",
        outputs: [
            {
                internalType: "address",
                name: "proxy",
                type: "address"
            }
        ],
        stateMutability: "payable",
        type: "function"
    }
] as const

// Safe's library for create and create2: https://github.com/safe-global/safe-contracts/blob/0acdd35a203299585438f53885df630f9d486a86/contracts/libraries/CreateCall.sol
// Address was found here: https://github.com/safe-global/safe-deployments/blob/926ec6bbe2ebcac3aa2c2c6c0aff74aa590cbc6a/src/assets/v1.4.1/create_call.json
const createCallAddress = "0x9b35Af71d77eaf8d7e40252370304687390A1A52"

const createCallAbi = parseAbi([
    "function performCreate(uint256 value, bytes memory deploymentData) public returns (address newContract)",
    "function performCreate2(uint256 value, bytes memory deploymentData, bytes32 salt) public returns (address newContract)"
])

/**
 * Default addresses for kernel smart account
 */
export const KERNEL_ADDRESSES: {
    ACCOUNT_V2_3_LOGIC: Address
    FACTORY_ADDRESS: Address
    ENTRYPOINT_V0_6: Address
} = {
    ACCOUNT_V2_3_LOGIC: "0xD3F582F6B4814E989Ee8E96bc3175320B5A540ab",
    FACTORY_ADDRESS: "0x5de4839a76cf55d0c90e2061ef4386d962E15ae3",
    ENTRYPOINT_V0_6: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
}

/**
 * Get the account initialization code for a kernel smart account
 * @param owner
 * @param index
 * @param factoryAddress
 * @param accountLogicAddress
 * @param ecdsaValidatorAddress
 */
const getAccountInitCode = async ({
    owner,
    index,
    factoryAddress,
    accountLogicAddress,
    validatorAddress,
    enableData
}: {
    owner: Address
    index: bigint
    factoryAddress: Address
    accountLogicAddress: Address
    validatorAddress: Address
    enableData: Promise<Hex>
}): Promise<Hex> => {
    if (!owner) throw new Error("Owner account not found")

    // Build the account initialization data
    const initialisationData = encodeFunctionData({
        abi: KernelInitAbi,
        functionName: "initialize",
        args: [validatorAddress, await enableData]
    })

    // Build the account init code
    return concatHex([
        factoryAddress,
        encodeFunctionData({
            abi: createAccountAbi,
            functionName: "createAccount",
            args: [accountLogicAddress, initialisationData, index]
        }) as Hex
    ])
}

/**
 * Check the validity of an existing account address, or fetch the pre-deterministic account address for a kernel smart wallet
 * @param client
 * @param entryPoint
 * @param initCodeProvider
 */
const getAccountAddress = async <
    TTransport extends Transport = Transport,
    TChain extends Chain | undefined = Chain | undefined
>({
    client,
    entryPoint,
    initCodeProvider
}: {
    client: Client<TTransport, TChain>
    initCodeProvider: () => Promise<Hex>
    entryPoint: Address
}): Promise<Address> => {
    // Find the init code for this account
    const initCode = await initCodeProvider()

    // Get the sender address based on the init code
    return getSenderAddress(client, {
        initCode,
        entryPoint
    })
}

/**
 * Build a kernel smart account from a private key, that use the ECDSA signer behind the scene
 * @param client
 * @param privateKey
 * @param entryPoint
 * @param index
 * @param factoryAddress
 * @param accountLogicAddress
 * @param ecdsaValidatorAddress
 * @param deployedAccountAddress
 */
export async function createKernelAccount<
    TTransport extends Transport = Transport,
    TChain extends Chain | undefined = Chain | undefined
>(
    client: Client<TTransport, TChain>,
    {
        defaultValidator,
        plugin,
        entryPoint = KERNEL_ADDRESSES.ENTRYPOINT_V0_6,
        index = 0n,
        factoryAddress = KERNEL_ADDRESSES.FACTORY_ADDRESS,
        accountLogicAddress = KERNEL_ADDRESSES.ACCOUNT_V2_3_LOGIC,
        deployedAccountAddress
    }: {
        defaultValidator: KernelPlugin<string, TTransport, TChain>
        plugin?: KernelPlugin<string, TTransport, TChain>
        entryPoint?: Address
        index?: bigint
        factoryAddress?: Address
        accountLogicAddress?: Address
        deployedAccountAddress?: Address
    }
): Promise<KernelSmartAccount<TTransport, TChain>> {
    const currentValidator = plugin ?? defaultValidator
    // Helper to generate the init code for the smart account
    const generateInitCode = () =>
        getAccountInitCode({
            owner: defaultValidator.signer.address,
            index,
            factoryAddress,
            accountLogicAddress,
            validatorAddress: defaultValidator.address,
            enableData: defaultValidator.getEnableData()
        })

    // Fetch account address and chain id
    const [accountAddress] = await Promise.all([
        deployedAccountAddress ??
            getAccountAddress<TTransport, TChain>({
                client,
                entryPoint,
                initCodeProvider: generateInitCode
            })
    ])

    if (!accountAddress) throw new Error("Account address not found")

    // Build the EOA Signer
    const account = toAccount({
        address: accountAddress,
        async signMessage({ message }) {
            return signMessage(client, {
                account: currentValidator.signer,
                message
            })
        },
        async signTransaction(_, __) {
            throw new SignTransactionNotSupportedBySmartAccount()
        },
        async signTypedData(typedData) {
            return signTypedData(client, {
                account: currentValidator.signer,
                ...typedData
            })
        }
    })

    return {
        ...account,
        client: client,
        publicKey: accountAddress,
        entryPoint: entryPoint,
        source: "kernelSmartAccount",

        // Get the nonce of the smart account
        async getNonce() {
            return getAccountNonce(client, {
                sender: accountAddress,
                entryPoint: entryPoint
            })
        },

        // Sign a user operation
        async signUserOperation(userOperation) {
            let pluginEnableSignature
            if (plugin) {
                pluginEnableSignature =
                    await defaultValidator.getPluginApproveSignature(
                        accountAddress,
                        plugin
                    )
            }
            return currentValidator.signUserOperation(
                userOperation,
                pluginEnableSignature
            )
        },

        // Encode the init code
        async getInitCode() {
            const contractCode = await getBytecode(client, {
                address: accountAddress
            })

            if ((contractCode?.length ?? 0) > 2) return "0x"

            return generateInitCode()
        },

        // Encode the deploy call data
        async encodeDeployCallData(_tx) {
            return encodeFunctionData({
                abi: KernelExecuteAbi,
                functionName: "executeDelegateCall",
                args: [
                    createCallAddress,
                    encodeFunctionData({
                        abi: createCallAbi,
                        functionName: "performCreate",
                        args: [
                            0n,
                            encodeDeployData({
                                abi: _tx.abi,
                                bytecode: _tx.bytecode,
                                args: _tx.args
                            } as EncodeDeployDataParameters)
                        ]
                    })
                ]
            })
        },

        // Encode a call
        async encodeCallData(_tx) {
            if (Array.isArray(_tx)) {
                // Encode a batched call
                return encodeFunctionData({
                    abi: KernelExecuteAbi,
                    functionName: "executeBatch",
                    args: [
                        _tx.map((tx) => ({
                            to: tx.to,
                            value: tx.value,
                            data: tx.data
                        }))
                    ]
                })
            }
            // Encode a simple call
            return encodeFunctionData({
                abi: KernelExecuteAbi,
                functionName: "execute",
                args: [_tx.to, _tx.value, _tx.data, 0]
            })
        },

        // Get simple dummy signature
        async getDummySignature(userOperation) {
            let pluginEnableSignature
            if (plugin) {
                pluginEnableSignature =
                    await defaultValidator.getPluginApproveSignature(
                        accountAddress,
                        plugin
                    )
            }
            return currentValidator.getDummySignature(
                userOperation,
                pluginEnableSignature
            )
        }
    }
}
