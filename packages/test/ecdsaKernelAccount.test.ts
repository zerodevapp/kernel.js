import { beforeAll, describe, expect, test } from "bun:test"
import { createKernelAccount } from "@kerneljs/core/accounts"
import { signerToEcdsaValidator } from "@kerneljs/ecdsa-validator"
import dotenv from "dotenv"
import { BundlerClient, SmartAccountClient } from "permissionless"
import {
    SignTransactionNotSupportedBySmartAccount,
    SmartAccount
} from "permissionless/accounts"
import type { UserOperation } from "permissionless/types/userOperation.js"
import {
    Address,
    Chain,
    Hex,
    type PublicClient,
    Transport,
    decodeEventLog,
    getContract,
    zeroAddress
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { EntryPointAbi } from "./abis/EntryPoint.js"
import { GreeterAbi, GreeterBytecode } from "./abis/Greeter.js"
import {
    findUserOperationEvent,
    getEntryPoint,
    getKernelBundlerClient,
    getPublicClient,
    getSignerToEcdsaKernelAccount,
    getSmartAccountClient,
    getZeroDevPaymasterClient
} from "./utils.js"

dotenv.config()

const requiredEnvVars = [
    "PIMLICO_API_KEY",
    "STACKUP_API_KEY",
    "FACTORY_ADDRESS",
    "TEST_PRIVATE_KEY",
    "RPC_URL",
    "ENTRYPOINT_ADDRESS",
    "GREETER_ADDRESS",
    "ZERODEV_PROJECT_ID",
    "ZERODEV_BUNDLER_RPC_HOST",
    "ZERODEV_PAYMASTER_RPC_HOST"
]

const validateEnvironmentVariables = (envVars: string[]): void => {
    const unsetEnvVars = envVars.filter((envVar) => !process.env[envVar])
    if (unsetEnvVars.length > 0) {
        throw new Error(
            `The following environment variables are not set: ${unsetEnvVars.join(
                ", "
            )}`
        )
    }
}

validateEnvironmentVariables(requiredEnvVars)

const ETHEREUM_ADDRESS_LENGTH = 42
const ETHEREUM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE_LENGTH = 132
const SIGNATURE_REGEX = /^0x[0-9a-fA-F]{130}$/
const TX_HASH_LENGTH = 66
const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/
const TEST_TIMEOUT = 1000000

describe("ECDSA kernel Account", () => {
    let account: SmartAccount
    let publicClient: PublicClient
    let bundlerClient: BundlerClient
    let smartAccountClient: SmartAccountClient<Transport, Chain, SmartAccount>

    beforeAll(async () => {
        account = await getSignerToEcdsaKernelAccount()
        publicClient = await getPublicClient()
        bundlerClient = getKernelBundlerClient()
        smartAccountClient = await getSmartAccountClient({
            account,
            sponsorUserOperation: async ({ userOperation }) => {
                const zerodevPaymaster = getZeroDevPaymasterClient()
                const entryPoint = getEntryPoint()
                return zerodevPaymaster.sponsorUserOperation({
                    userOperation,
                    entryPoint
                })
            }
        })
    })

    test("Account address should be a valid Ethereum address", async () => {
        expect(account.address).toBeString()
        expect(account.address).toHaveLength(ETHEREUM_ADDRESS_LENGTH)
        expect(account.address).toMatch(ETHEREUM_ADDRESS_REGEX)
    })

    test("Account should throw when trying to sign a transaction", async () => {
        await expect(async () => {
            await account.signTransaction({
                to: zeroAddress,
                value: 0n,
                data: "0x"
            })
        }).toThrow(new SignTransactionNotSupportedBySmartAccount())
    })

    test("Client signMessage should return a valid signature", async () => {
        const message = "hello world"
        const response = await smartAccountClient.signMessage({
            message
        })

        expect(response).toBeString()
        expect(response).toHaveLength(SIGNATURE_LENGTH)
        expect(response).toMatch(SIGNATURE_REGEX)
    })

    test("Smart account client signTypedData", async () => {
        const domain = {
            chainId: 1,
            name: "Test",
            verifyingContract: zeroAddress
        }

        const primaryType = "Test"

        const types = {
            Test: [
                {
                    name: "test",
                    type: "string"
                }
            ]
        }

        const message = {
            test: "hello world"
        }
        const response = await smartAccountClient.signTypedData({
            domain,
            primaryType,
            types,
            message
        })

        expect(response).toBeString()
        expect(response).toHaveLength(SIGNATURE_LENGTH)
        expect(response).toMatch(SIGNATURE_REGEX)
    })

    test(
        "Client deploy contract",
        async () => {
            const response = await smartAccountClient.deployContract({
                abi: GreeterAbi,
                bytecode: GreeterBytecode
            })

            expect(response).toBeString()
            expect(response).toHaveLength(TX_HASH_LENGTH)
            expect(response).toMatch(TX_HASH_REGEX)

            const transactionReceipt =
                await publicClient.waitForTransactionReceipt({
                    hash: response
                })

            expect(findUserOperationEvent(transactionReceipt.logs)).toBeTrue()
        },
        TEST_TIMEOUT
    )

    test(
        "Smart account client send multiple transactions",
        async () => {
            const response = await smartAccountClient.sendTransactions({
                transactions: [
                    {
                        to: zeroAddress,
                        value: 0n,
                        data: "0x"
                    },
                    {
                        to: zeroAddress,
                        value: 0n,
                        data: "0x"
                    }
                ]
            })
            expect(response).toBeString()
            expect(response).toHaveLength(TX_HASH_LENGTH)
            expect(response).toMatch(TX_HASH_REGEX)
        },
        TEST_TIMEOUT
    )

    test(
        "Write contract",
        async () => {
            const greeterContract = getContract({
                abi: GreeterAbi,
                address: process.env.GREETER_ADDRESS as Address,
                publicClient: await getPublicClient(),
                walletClient: smartAccountClient
            })

            const oldGreet = await greeterContract.read.greet()

            expect(oldGreet).toBeString()

            const txHash = await greeterContract.write.setGreeting([
                "hello world"
            ])

            expect(txHash).toBeString()
            expect(txHash).toHaveLength(66)

            const newGreet = await greeterContract.read.greet()

            expect(newGreet).toBeString()
            expect(newGreet).toEqual("hello world")
        },
        TEST_TIMEOUT
    )

    test(
        "Client send Transaction with paymaster",
        async () => {
            const response = await smartAccountClient.sendTransaction({
                to: zeroAddress,
                value: 0n,
                data: "0x"
            })

            expect(response).toBeString()
            expect(response).toHaveLength(TX_HASH_LENGTH)
            expect(response).toMatch(TX_HASH_REGEX)

            const transactionReceipt =
                await publicClient.waitForTransactionReceipt({
                    hash: response
                })

            expect(findUserOperationEvent(transactionReceipt.logs)).toBeTrue()
        },
        TEST_TIMEOUT
    )

    test(
        "Client send multiple Transactions with paymaster",
        async () => {
            const account = await getSignerToEcdsaKernelAccount()

            const publicClient = await getPublicClient()

            const bundlerClient = getKernelBundlerClient()

            const smartAccountClient = await getSmartAccountClient({
                account,
                sponsorUserOperation: async ({
                    entryPoint: _entryPoint,
                    userOperation
                }): Promise<UserOperation> => {
                    const zerodevPaymaster = getZeroDevPaymasterClient()
                    return zerodevPaymaster.sponsorUserOperation({
                        userOperation,
                        entryPoint: getEntryPoint()
                    })
                }
            })

            const response = await smartAccountClient.sendTransactions({
                transactions: [
                    {
                        to: zeroAddress,
                        value: 0n,
                        data: "0x"
                    },
                    {
                        to: zeroAddress,
                        value: 0n,
                        data: "0x"
                    }
                ]
            })

            expect(response).toBeString()
            expect(response).toHaveLength(66)
            expect(response).toMatch(/^0x[0-9a-fA-F]{64}$/)

            const transactionReceipt =
                await publicClient.waitForTransactionReceipt({
                    hash: response
                })

            let eventFound = false

            for (const log of transactionReceipt.logs) {
                // Encapsulated inside a try catch since if a log isn't wanted from this abi it will throw an error
                try {
                    const event = decodeEventLog({
                        abi: EntryPointAbi,
                        ...log
                    })
                    if (event.eventName === "UserOperationEvent") {
                        eventFound = true
                        const userOperation =
                            await bundlerClient.getUserOperationByHash({
                                hash: event.args.userOpHash
                            })
                        expect(
                            userOperation?.userOperation.paymasterAndData
                        ).not.toBe("0x")
                    }
                } catch {}
            }

            expect(eventFound).toBeTrue()
        },
        TEST_TIMEOUT
    )

    test(
        "Can use a deployed account",
        async () => {
            const initialEcdsaSmartAccount =
                await getSignerToEcdsaKernelAccount()
            const publicClient = await getPublicClient()
            const smartAccountClient = await getSmartAccountClient({
                account: initialEcdsaSmartAccount,
                sponsorUserOperation: async ({
                    entryPoint: _entryPoint,
                    userOperation
                }): Promise<UserOperation> => {
                    const zerodevPaymaster = getZeroDevPaymasterClient()
                    return zerodevPaymaster.sponsorUserOperation({
                        userOperation,
                        entryPoint: getEntryPoint()
                    })
                }
            })

            // Send an initial tx to deploy the account
            const hash = await smartAccountClient.sendTransaction({
                to: zeroAddress,
                value: 0n,
                data: "0x"
            })

            // Wait for the tx to be done (so we are sure that the account is deployed)
            await publicClient.waitForTransactionReceipt({ hash })
            const deployedAccountAddress = initialEcdsaSmartAccount.address

            // Build a new account with a valid owner
            const signer = privateKeyToAccount(
                process.env.TEST_PRIVATE_KEY as Hex
            )
            const ecdsaValidatorPlugin = await signerToEcdsaValidator(
                publicClient,
                {
                    entryPoint: getEntryPoint(),
                    signer
                }
            )
            const alreadyDeployedEcdsaSmartAccount = await createKernelAccount(
                publicClient,
                {
                    entryPoint: getEntryPoint(),
                    defaultValidator: ecdsaValidatorPlugin,
                    deployedAccountAddress
                }
            )

            // Ensure the two account have the same address
            expect(alreadyDeployedEcdsaSmartAccount.address).toMatch(
                initialEcdsaSmartAccount.address
            )
        },
        TEST_TIMEOUT
    )
})
