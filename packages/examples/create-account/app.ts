import "dotenv/config"
import { signerToEcdsaValidator } from "@kerneljs/ecdsa-validator"
import { http, createPublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { polygonMumbai } from "viem/chains"
import { createKernelAccount } from "@kerneljs/core"

const publicClient = createPublicClient({
  transport: http(
    `https://meta-aa-provider.onrender.com/api/v2/bundler/${process.env.ZERODEV_PROJECT_ID}`
  ),
  chain: polygonMumbai
})

const signer = privateKeyToAccount(process.env.PRIVATE_KEY as "0x...")

const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
  signer,
})

const account = createKernelAccount(publicClient, {
  plugin: ecdsaValidator,
})
