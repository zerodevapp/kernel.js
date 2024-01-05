import {
    type Abi,
    type Account,
    type Address,
    type Chain,
    type Client,
    type GetAbiItemParameters,
    type Hex,
    type InferFunctionName,
    type LocalAccount,
    type Narrow,
    type Transport,
    getFunctionSelector,
    hexToSignature,
    isHex,
    keccak256,
    pad,
    signatureToHex,
    toHex,
    zeroAddress
} from "viem"
import { toAccount } from "viem/accounts"
import {
    getChainId,
    readContract,
    signMessage,
    signTypedData
} from "viem/actions"
import {
    concat,
    decodeFunctionData,
    encodeAbiParameters,
    getAbiItem
} from "viem/utils"
import { SessionKeyValidatorAbi } from "./abi/SessionKeyValidatorAbi.js"

import { KernelAccountAbi } from "@kerneljs/core"
import { KERNEL_ADDRESSES } from "@kerneljs/core"
import { constants } from "@kerneljs/core"
import type { KernelPlugin } from "@kerneljs/core/types"
import { ValidatorMode } from "@kerneljs/core/types"
import {
    type AbiFunction,
    type AbiParameter,
    type AbiParameterKind,
    type AbiParameterToPrimitiveType,
    type ExtractAbiFunction
} from "abitype"
import { type Pretty } from "abitype/src/types.js"
import { MerkleTree } from "merkletreejs"
import { getAction, getUserOperationHash } from "permissionless"
import {
    SignTransactionNotSupportedBySmartAccount,
    type SmartAccountSigner
} from "permissionless/accounts"
import { SESSION_KEY_VALIDATOR_ADDRESS } from "./index.js"

export type SessionNonces = {
    lastNonce: bigint
    invalidNonce: bigint
}

export enum Operation {
    Call = 0,
    DelegateCall = 1
}

enum ParamOperator {
    EQUAL = 0,
    GREATER_THAN = 1,
    LESS_THAN = 2,
    GREATER_THAN_OR_EQUAL = 3,
    LESS_THAN_OR_EQUAL = 4,
    NOT_EQUAL = 5
}

// type SessionNonces = {
//   lastNonce: bigint;
//   invalidNonce: bigint;
// };

type ExecutionRule = {
    validAfter: number // 48 bits
    interval: number // 48 bits
    runs: number // 48 bits
}
interface ParamRules {
    offset: number
    condition: ParamOperator
    param: Hex
}

type Permission = {
    target: Address
    index?: number
    rules?: ParamRules[]
    sig?: Hex
    valueLimit?: bigint
    executionRule?: ExecutionRule
    operation?: Operation
}

interface SessionKeyData {
    validUntil?: number
    validAfter?: number
    paymaster?: Address
    permissions?: Permission[]
}

export type SessionKeyValidatorPlugin<
    TTransport extends Transport = Transport,
    TChain extends Chain | undefined = Chain | undefined
> = KernelPlugin<"SessionKeyValidator", TTransport, TChain> & {
    merkleTree: MerkleTree
}

export type SessionKeyValidatorData = {
    sessionKey: Account
    sessionKeyData?: SessionKeyData
}

export type ExecutorData = {
    executor: Address
    selector: Hex
    validUntil: number
    validAfter: number
}

export async function signerToSessionKeyValidator<
    TTransport extends Transport = Transport,
    TChain extends Chain | undefined = Chain | undefined,
    TSource extends string = "custom",
    TAddress extends Address = Address
>(
    client: Client<TTransport, TChain>,
    {
        signer,
        entryPoint = KERNEL_ADDRESSES.ENTRYPOINT_V0_6,
        validatorData,
        validatorAddress = SESSION_KEY_VALIDATOR_ADDRESS,
        executorData,
        mode = ValidatorMode.enable
    }: {
        signer: SmartAccountSigner<TSource, TAddress>
        validatorData: SessionKeyValidatorData
        entryPoint?: Address
        validatorAddress?: Address
        executorData?: ExecutorData
        mode?: ValidatorMode
    }
): Promise<SessionKeyValidatorPlugin<TTransport, TChain>> {
    const _executorData = executorData ?? {
        executor: zeroAddress,
        selector: getFunctionSelector(
            "execute(address, uint256, bytes, uint8)"
        ),
        validAfter: 0,
        validUntil: 0
    }
    const sessionKeyData: SessionKeyData = {
        ...validatorData.sessionKeyData,
        validAfter: validatorData?.sessionKeyData?.validAfter ?? 0,
        validUntil: validatorData?.sessionKeyData?.validUntil ?? 0,
        paymaster: validatorData?.sessionKeyData?.paymaster ?? zeroAddress
    }
    sessionKeyData.permissions =
        sessionKeyData.permissions?.map((perm, index) => ({
            ...perm,
            valueLimit: perm.valueLimit ?? 0n,
            sig: perm.sig ?? pad("0x", { size: 4 }),
            rules: perm.rules ?? [],
            index,
            executionRule: perm.executionRule ?? {
                validAfter: 0,
                interval: 0,
                runs: 0
            },
            operation: perm.operation ?? Operation.Call
        })) ?? []
    const viemSigner: LocalAccount = {
        ...signer,
        signTransaction: (_, __) => {
            throw new SignTransactionNotSupportedBySmartAccount()
        }
    } as LocalAccount

    // // Fetch chain id
    const [chainId] = await Promise.all([getChainId(client)])

    // Build the EOA Signer
    const account = toAccount({
        address: viemSigner.address,
        async signMessage({ message }) {
            return signMessage(client, { account: viemSigner, message })
        },
        async signTransaction(_, __) {
            throw new SignTransactionNotSupportedBySmartAccount()
        },
        async signTypedData(typedData) {
            return signTypedData(client, { account: viemSigner, ...typedData })
        }
    })

    const encodedPermissionData = sessionKeyData.permissions.map((permission) =>
        encodePermissionData(permission)
    )

    if (encodedPermissionData.length && encodedPermissionData.length === 1)
        encodedPermissionData.push(encodedPermissionData[0])

    const merkleTree: MerkleTree = sessionKeyData.permissions?.length
        ? new MerkleTree(encodedPermissionData, keccak256, {
              sortPairs: true,
              hashLeaves: true
          })
        : new MerkleTree([pad("0x00", { size: 32 })], keccak256, {
              hashLeaves: false,
              complete: true
          })

    const getEnableData = async (
        kernelAccountAddress?: Address
    ): Promise<Hex> => {
        console.log("kernelAccountAddress", kernelAccountAddress)
        if (!kernelAccountAddress) {
            throw new Error("Kernel account address not provided")
        }
        const lastNonce =
            (await getSessionNonces(kernelAccountAddress)).lastNonce + 1n
        console.log("lastNonce", lastNonce)
        return concat([
            validatorData?.sessionKey.address,
            pad(merkleTree.getHexRoot() as Hex, { size: 32 }),
            pad(toHex(sessionKeyData?.validAfter ?? 0), {
                size: 6
            }),
            pad(toHex(sessionKeyData?.validUntil ?? 0), {
                size: 6
            }),
            sessionKeyData?.paymaster ?? zeroAddress,
            pad(toHex(lastNonce), { size: 32 })
        ])
    }

    const getSessionNonces = async (
        kernelAccountAddress: Address
    ): Promise<SessionNonces> => {
        const nonce = await getAction(
            client,
            readContract
        )({
            abi: SessionKeyValidatorAbi,
            address: validatorAddress,
            functionName: "nonces",
            args: [kernelAccountAddress]
        })
        console.log("nonce", nonce)

        return { lastNonce: nonce[0], invalidNonce: nonce[1] }
    }

    const getValidatorSignature = async (
        accountAddress: Address,
        pluginEnableSignature?: Hex
    ): Promise<Hex> => {
        if (mode === ValidatorMode.sudo || mode === ValidatorMode.plugin) {
            return mode
        }
        const enableData = await getEnableData(accountAddress)
        const enableDataLength = enableData.length / 2 - 1
        const enableSignature = pluginEnableSignature
        if (!enableSignature) {
            throw new Error("Enable signature not set")
        }
        return concat([
            mode, // 4 bytes 0 - 4
            pad(toHex(_executorData.validUntil), { size: 6 }), // 6 bytes 4 - 10
            pad(toHex(_executorData.validAfter), { size: 6 }), // 6 bytes 10 - 16
            pad(validatorAddress, { size: 20 }), // 20 bytes 16 - 36
            pad(_executorData.executor, { size: 20 }), // 20 bytes 36 - 56
            pad(toHex(enableDataLength), { size: 32 }), // 32 bytes 56 - 88
            enableData, // 88 - 88 + enableData.length
            pad(toHex(enableSignature.length / 2 - 1), { size: 32 }), // 32 bytes 88 + enableData.length - 120 + enableData.length
            enableSignature // 120 + enableData.length - 120 + enableData.length + enableSignature.length
        ])
    }

    const findMatchingPermissions = (
        callData: Hex
    ): Permission | Permission[] | undefined => {
        try {
            const { functionName, args } = decodeFunctionData({
                abi: KernelAccountAbi,
                data: callData
            })

            if (functionName !== "execute" && functionName !== "executeBatch")
                return undefined
            if (functionName === "execute") {
                const [to, value, data] = args
                return filterPermissions([to], [data], [value])?.[0]
            } else if (functionName === "executeBatch") {
                const targets: Hex[] = []
                const values: bigint[] = []
                const dataArray: Hex[] = []
                for (const arg of args[0]) {
                    targets.push(arg.to)
                    values.push(arg.value)
                    dataArray.push(arg.data)
                }
                return filterPermissions(targets, dataArray, values)
            }
            throw Error("Invalid function")
        } catch (error) {
            return undefined
        }
    }

    const filterPermissions = (
        targets: Address[],
        dataArray: Hex[],
        values: bigint[]
    ): Permission[] | undefined => {
        if (
            targets.length !== dataArray.length ||
            targets.length !== values.length
        ) {
            throw Error("Invalid arguments")
        }
        const filteredPermissions = targets.map((target, index) => {
            const permissionsList = sessionKeyData?.permissions
            if (!permissionsList || !permissionsList.length) return undefined

            const targetToMatch = target.toLowerCase()

            // Filter permissions by target
            const targetPermissions = permissionsList.filter(
                (permission) =>
                    permission.target.toLowerCase() === targetToMatch ||
                    permission.target.toLowerCase() ===
                        zeroAddress.toLowerCase()
            )

            if (!targetPermissions.length) return undefined

            const operationPermissions = filterByOperation(
                targetPermissions,
                // [TODO]: Check if we need to pass operation from userOp after Kernel v2.3 in
                Operation.Call
            )

            if (!operationPermissions.length) return undefined

            const signaturePermissions = filterBySignature(
                targetPermissions,
                dataArray[index].slice(0, 10).toLowerCase()
            )

            const valueLimitPermissions = signaturePermissions.filter(
                (permission) => (permission.valueLimit ?? 0n) >= values[index]
            )

            if (!valueLimitPermissions.length) return undefined

            const sortedPermissions = valueLimitPermissions.sort((a, b) => {
                if ((b.valueLimit ?? 0n) > (a.valueLimit ?? 0n)) {
                    return 1
                } else if ((b.valueLimit ?? 0n) < (a.valueLimit ?? 0n)) {
                    return -1
                } else {
                    return 0
                }
            })

            return findPermissionByRule(sortedPermissions, dataArray[index])
        })
        return filteredPermissions.every(
            (permission) => permission !== undefined
        )
            ? (filteredPermissions as Permission[])
            : undefined
    }

    const filterByOperation = (
        permissions: Permission[],
        operation: Operation
    ): Permission[] => {
        return permissions.filter(
            (permission) =>
                permission.operation === operation ||
                Operation.Call === operation
        )
    }

    const filterBySignature = (
        permissions: Permission[],
        signature: string
    ): Permission[] => {
        return permissions.filter(
            (permission) =>
                (permission.sig ?? pad("0x", { size: 4 })).toLowerCase() ===
                signature
        )
    }

    const findPermissionByRule = (
        permissions: Permission[],
        data: string
    ): Permission | undefined => {
        return permissions.find((permission) => {
            for (const rule of permission.rules ?? []) {
                const dataParam: Hex = getFormattedHex(
                    `0x${data.slice(
                        10 + rule.offset * 2,
                        10 + rule.offset * 2 + 64
                    )}`
                )
                const ruleParam: Hex = getFormattedHex(rule.param)

                if (
                    !evaluateRuleCondition(dataParam, ruleParam, rule.condition)
                ) {
                    return false
                }
            }
            return true
        })
    }

    const getFormattedHex = (value: string): Hex => {
        return pad(isHex(value) ? value : toHex(value), {
            size: 32
        }).toLowerCase() as Hex
    }

    const evaluateRuleCondition = (
        dataParam: Hex,
        ruleParam: Hex,
        condition: ParamOperator
    ): boolean => {
        switch (condition) {
            case ParamOperator.EQUAL:
                return dataParam === ruleParam
            case ParamOperator.GREATER_THAN:
                return dataParam > ruleParam
            case ParamOperator.LESS_THAN:
                return dataParam < ruleParam
            case ParamOperator.GREATER_THAN_OR_EQUAL:
                return dataParam >= ruleParam
            case ParamOperator.LESS_THAN_OR_EQUAL:
                return dataParam <= ruleParam
            case ParamOperator.NOT_EQUAL:
                return dataParam !== ruleParam
            default:
                return false
        }
    }

    const getEncodedPermissionProofData = (callData: Hex): Hex => {
        const matchingPermission = findMatchingPermissions(callData)
        console.log("matchingPermission", matchingPermission)
        // [TODO]: add shouldDelegateViaFallback() check
        if (
            !matchingPermission &&
            !(merkleTree.getHexRoot() === pad("0x00", { size: 32 }))
        ) {
            throw Error(
                "SessionKeyValidator: No matching permission found for the userOp"
            )
        }
        const encodedPermissionData =
            sessionKeyData?.permissions &&
            sessionKeyData.permissions.length !== 0 &&
            matchingPermission
                ? encodePermissionData(matchingPermission)
                : "0x"
        let merkleProof: string[] | string[][] = []
        if (Array.isArray(matchingPermission)) {
            const encodedPerms = matchingPermission.map((permission) =>
                keccak256(encodePermissionData(permission))
            )
            merkleProof = encodedPerms.map((perm) =>
                merkleTree.getHexProof(perm)
            )
        } else if (matchingPermission) {
            merkleProof = merkleTree.getHexProof(
                keccak256(encodedPermissionData)
            )
        }
        return sessionKeyData?.permissions &&
            sessionKeyData.permissions.length !== 0 &&
            matchingPermission
            ? encodePermissionData(matchingPermission, merkleProof)
            : "0x"
    }

    // const merkleRoot = merkleTree.getHexRoot();
    return {
        ...account,
        address: validatorAddress,
        signer: viemSigner,
        client: client,
        entryPoint: entryPoint,
        merkleTree,
        source: "SessionKeyValidator",
        getEnableData,

        signUserOperation: async (
            userOperation,
            pluginEnableSignature
        ): Promise<Hex> => {
            const userOpHash = getUserOperationHash({
                userOperation: { ...userOperation, signature: "0x" },
                entryPoint,
                chainId: chainId
            })

            const signature = await signMessage(client, {
                account: viemSigner,
                message: { raw: userOpHash }
            })
            const fixedSignature = fixSignedData(signature)
            return concat([
                await getValidatorSignature(
                    userOperation.sender,
                    pluginEnableSignature
                ),
                validatorData.sessionKey.address,
                fixedSignature,
                getEncodedPermissionProofData(userOperation.callData)
            ])
        },

        getNonceKey: async () => {
            return 0n
        },

        async getDummySignature(userOperation, pluginEnableSignature) {
            console.log("userOperation", userOperation)
            return concat([
                await getValidatorSignature(
                    userOperation.sender,
                    pluginEnableSignature
                ),
                validatorData.sessionKey.address,
                constants.DUMMY_ECDSA_SIG,
                getEncodedPermissionProofData(userOperation.callData)
            ])
        },
        getPluginApproveSignature: async () => {
            throw new Error("Not implemented")
        },
        getExecutorData: () => {
            if (!_executorData?.selector || !_executorData?.executor) {
                throw new Error("Invalid executor data")
            }
            return _executorData
        }
    }
}

export const encodePermissionData = (
    permission: Permission | Permission[],
    merkleProof?: string[] | string[][]
): Hex => {
    const permissionParam = {
        components: [
            {
                name: "index",
                type: "uint32"
            },
            {
                name: "target",
                type: "address"
            },
            {
                name: "sig",
                type: "bytes4"
            },
            {
                name: "valueLimit",
                type: "uint256"
            },
            {
                components: [
                    {
                        name: "offset",
                        type: "uint256"
                    },
                    {
                        internalType: "enum ParamCondition",
                        name: "condition",
                        type: "uint8"
                    },
                    {
                        name: "param",
                        type: "bytes32"
                    }
                ],
                name: "rules",
                type: "tuple[]"
            },
            {
                components: [
                    {
                        name: "interval",
                        type: "uint48"
                    },
                    {
                        name: "runs",
                        type: "uint48"
                    },
                    {
                        internalType: "ValidAfter",
                        name: "validAfter",
                        type: "uint48"
                    }
                ],
                name: "executionRule",
                type: "tuple"
            },
            {
                internalType: "enum Operation",
                name: "operation",
                type: "uint8"
            }
        ],
        name: "permission",
        type: Array.isArray(permission) ? "tuple[]" : "tuple"
    }
    let params
    let values
    if (merkleProof) {
        params = [
            permissionParam,
            {
                name: "merkleProof",
                type: Array.isArray(merkleProof[0])
                    ? "bytes32[][]"
                    : "bytes32[]"
            }
        ]
        values = [permission, merkleProof]
    } else {
        params = [permissionParam]
        values = [permission]
    }
    return encodeAbiParameters(params, values)
}

export function getPermissionFromABI<
    TAbi extends Abi | readonly unknown[],
    TFunctionName extends string | undefined = string
>({
    abi,
    target,
    args,
    functionName,
    valueLimit
}: GeneratePermissionFromArgsParameters<TAbi, TFunctionName>): Permission {
    const abiItem = getAbiItem({
        abi,
        args,
        name: functionName
    } as GetAbiItemParameters)
    if (abiItem.type !== "function") {
        throw Error(`${functionName} not found in abi`)
    }
    const functionSelector = getFunctionSelector(abiItem)
    let paramRules: ParamRules[] = []
    if (args && Array.isArray(args)) {
        paramRules = (args as CombinedArgs<AbiFunction["inputs"]>)
            .map(
                (arg, i) =>
                    arg && {
                        param: pad(
                            isHex(arg.value)
                                ? arg.value
                                : toHex(
                                      arg.value as Parameters<typeof toHex>[0]
                                  ),
                            { size: 32 }
                        ),
                        offset: i * 32,
                        condition: arg.operator
                    }
            )
            .filter((rule) => rule) as ParamRules[]
    }
    return {
        sig: functionSelector,
        rules: paramRules,
        target,
        valueLimit: valueLimit ?? 0n
    }
}

export type GetFunctionArgs<
    TAbi extends Abi | readonly unknown[],
    TFunctionName extends string,
    TAbiFunction extends AbiFunction = TAbi extends Abi
        ? ExtractAbiFunction<TAbi, TFunctionName>
        : AbiFunction,
    TArgs = CombinedArgs<TAbiFunction["inputs"]>,
    FailedToParseArgs =
        | ([TArgs] extends [never] ? true : false)
        | (readonly unknown[] extends TArgs ? true : false)
> = true extends FailedToParseArgs
    ? {
          args?: readonly unknown[]
      }
    : TArgs extends readonly []
      ? { args?: never }
      : {
              args?: TArgs
          }

export type GeneratePermissionFromArgsParameters<
    TAbi extends Abi | readonly unknown[],
    TFunctionName extends string | undefined = string,
    _FunctionName = TAbi extends Abi
        ? InferFunctionName<TAbi, TFunctionName>
        : never
> = Pick<Permission, "target" | "valueLimit"> & {
    functionName?: _FunctionName
} & (TFunctionName extends string
        ? { abi: Narrow<TAbi> } & GetFunctionArgs<TAbi, TFunctionName>
        : _FunctionName extends string
          ? { abi: [Narrow<TAbi[number]>] } & GetFunctionArgs<
                  TAbi,
                  _FunctionName
              >
          : never)

export type AbiParametersToPrimitiveTypes<
    TAbiParameters extends readonly AbiParameter[],
    TAbiParameterKind extends AbiParameterKind = AbiParameterKind
> = Pretty<{
    [K in keyof TAbiParameters]: AbiParameterToPrimitiveType<
        TAbiParameters[K],
        TAbiParameterKind
    >
}>

export type AbiParametersToConditons<
    TAbiParameters extends readonly AbiParameter[]
> = Pretty<{
    [K in keyof TAbiParameters]: ParamOperator
}>

export type CombinedArgs<
    TAbiParameters extends readonly AbiParameter[],
    TAbiParameterKind extends AbiParameterKind = AbiParameterKind
> = {
    [K in keyof TAbiParameters]: {
        operator: ParamOperator
        value: AbiParameterToPrimitiveType<TAbiParameters[K], TAbiParameterKind>
    } | null
}

export const fixSignedData = (sig: Hex): Hex => {
    let signature = sig
    if (!isHex(signature)) {
        signature = `0x${signature}`
        if (!isHex(signature)) {
            throw new Error(`Invalid signed data ${sig}`)
        }
    }

    let { r, s, v } = hexToSignature(signature)
    if (v === 0n || v === 1n) v += 27n
    const joined = signatureToHex({ r, s, v })
    return joined
}

// export const getChainId = async (
//   projectId: string,
//   backendUrl?: string
// ): Promise<number | undefined> => {
//   try {
//     const {
//       data: { chainId },
//     } = await axios.post(
//       `${backendUrl ?? BACKEND_URL}/v1/projects/get-chain-id`,
//       {
//         projectId,
//       },
//       {
//         headers: { "Content-Type": "application/json" },
//       }
//     );
//     return chainId;
//   } catch (error) {
//     console.log(error);
//     return undefined;
//   }
// };