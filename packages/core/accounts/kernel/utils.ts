import {
    type Address,
    type Chain,
    type Hash,
    type Hex,
    type PublicClient,
    type Transport,
    concat,
    encodeAbiParameters,
    parseAbiParameters
} from "viem"

// Code copied from Alchemy's AA SDK
// https://github.com/alchemyplatform/aa-sdk/blob/7e55a97e8e5155dc7e8b1f395f2f6d5861a064d0/packages/core/src/signer/utils.ts

export type SignWith6492Params = {
    factoryAddress: Address
    factoryCalldata: Hex
    signature: Hash
}

type VerifyEIP6492SignatureParams = {
    signer: Address
    hash: Hash
    signature: Hash
    client: PublicClient
}

export const wrapSignatureWith6492 = ({
    factoryAddress,
    factoryCalldata,
    signature
}: SignWith6492Params): Hash => {
    // wrap the signature as follows: https://eips.ethereum.org/EIPS/eip-6492
    // concat(
    //  abi.encode(
    //    (create2Factory, factoryCalldata, originalERC1271Signature),
    //    (address, bytes, bytes)),
    //    magicBytes
    // )
    return concat([
        encodeAbiParameters(parseAbiParameters("address, bytes, bytes"), [
            factoryAddress,
            factoryCalldata,
            signature
        ]),
        "0x6492649264926492649264926492649264926492649264926492649264926492"
    ])
}

// defined in https://github.com/AmbireTech/signature-validator/blob/main/index.ts#L13C17-L13C17
const universalValidatorByteCode =
    "0x60806040523480156200001157600080fd5b50604051620007003803806200070083398101604081905262000034916200056f565b6000620000438484846200004f565b9050806000526001601ff35b600080846001600160a01b0316803b806020016040519081016040528181526000908060200190933c90507f6492649264926492649264926492649264926492649264926492649264926492620000a68462000451565b036200021f57600060608085806020019051810190620000c79190620005ce565b8651929550909350915060000362000192576000836001600160a01b031683604051620000f5919062000643565b6000604051808303816000865af19150503d806000811462000134576040519150601f19603f3d011682016040523d82523d6000602084013e62000139565b606091505b5050905080620001905760405162461bcd60e51b815260206004820152601e60248201527f5369676e617475726556616c696461746f723a206465706c6f796d656e74000060448201526064015b60405180910390fd5b505b604051630b135d3f60e11b808252906001600160a01b038a1690631626ba7e90620001c4908b90869060040162000661565b602060405180830381865afa158015620001e2573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906200020891906200069d565b6001600160e01b031916149450505050506200044a565b805115620002b157604051630b135d3f60e11b808252906001600160a01b03871690631626ba7e9062000259908890889060040162000661565b602060405180830381865afa15801562000277573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906200029d91906200069d565b6001600160e01b031916149150506200044a565b8251604114620003195760405162461bcd60e51b815260206004820152603a6024820152600080516020620006e083398151915260448201527f3a20696e76616c6964207369676e6174757265206c656e677468000000000000606482015260840162000187565b620003236200046b565b506020830151604080850151855186939260009185919081106200034b576200034b620006c9565b016020015160f81c9050601b81148015906200036b57508060ff16601c14155b15620003cf5760405162461bcd60e51b815260206004820152603b6024820152600080516020620006e083398151915260448201527f3a20696e76616c6964207369676e617475726520762076616c75650000000000606482015260840162000187565b6040805160008152602081018083528a905260ff83169181019190915260608101849052608081018390526001600160a01b038a169060019060a0016020604051602081039080840390855afa1580156200042e573d6000803e3d6000fd5b505050602060405103516001600160a01b031614955050505050505b9392505050565b60006020825110156200046357600080fd5b508051015190565b60405180606001604052806003906020820280368337509192915050565b6001600160a01b03811681146200049f57600080fd5b50565b634e487b7160e01b600052604160045260246000fd5b60005b83811015620004d5578181015183820152602001620004bb565b50506000910152565b600082601f830112620004f057600080fd5b81516001600160401b03808211156200050d576200050d620004a2565b604051601f8301601f19908116603f01168101908282118183101715620005385762000538620004a2565b816040528381528660208588010111156200055257600080fd5b62000565846020830160208901620004b8565b9695505050505050565b6000806000606084860312156200058557600080fd5b8351620005928162000489565b6020850151604086015191945092506001600160401b03811115620005b657600080fd5b620005c486828701620004de565b9150509250925092565b600080600060608486031215620005e457600080fd5b8351620005f18162000489565b60208501519093506001600160401b03808211156200060f57600080fd5b6200061d87838801620004de565b935060408601519150808211156200063457600080fd5b50620005c486828701620004de565b6000825162000657818460208701620004b8565b9190910192915050565b828152604060208201526000825180604084015262000688816060850160208701620004b8565b601f01601f1916919091016060019392505050565b600060208284031215620006b057600080fd5b81516001600160e01b0319811681146200044a57600080fd5b634e487b7160e01b600052603260045260246000fdfe5369676e617475726556616c696461746f72237265636f7665725369676e6572"

export const verifyEIP6492Signature = async ({
    signer,
    hash,
    signature,
    client
}: VerifyEIP6492SignatureParams): Promise<boolean> => {
    const result = await client.call({
        data: concat([
            universalValidatorByteCode,
            encodeAbiParameters(parseAbiParameters("address, bytes32, bytes"), [
                signer,
                hash,
                signature
            ])
        ])
    })

    return result.data === "0x01"
}

export const isAccountDeployed = async <
    TTransport extends Transport = Transport,
    TChain extends Chain | undefined = Chain | undefined
>(
    client: PublicClient<TTransport, TChain>,
    address: Hex
): Promise<boolean> => {
    const contractCode = await client.getBytecode({
        address
    })

    console.log("contract code: ", contractCode)

    return (contractCode?.length ?? 0) > 2
}
