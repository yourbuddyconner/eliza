import {
    IAgentRuntime,
    Memory,
    State,
    ModelClass,
    composeContext,
    generateObject,
    HandlerCallback
} from "@ai16z/eliza";
import { WalletProvider, evmWalletProvider } from "../providers/wallet";
import { getbalanceTemplate } from "../templates";
import { SupportedChain } from "../types";
import { formatUnits } from "viem";
import { erc20Abi } from "../abis/erc20";

export { getbalanceTemplate };

interface GetBalanceParams {
    chain: SupportedChain;
    tokenAddress?: `0x${string}`;
    decimals?: number;
}

// Validate the generated content structure
function isGetBalanceContent(content: any): content is GetBalanceParams {
    return (
        typeof content === "object" &&
        content !== null &&
        typeof content.chain === "string" &&
        ["ethereum", "base", "sepolia"].includes(content.chain) &&
        (content.tokenAddress === undefined || typeof content.tokenAddress === "string") &&
        (content.decimals === undefined || typeof content.decimals === "number")
    );
}

export const getbalanceAction = {
    name: "getbalance",
    description: "Get wallet balance on specified chain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        try {
            // Compose state if not provided
            if (!state) {
                state = (await runtime.composeState(message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            // Get wallet info for context
            const walletInfo = await evmWalletProvider.get(runtime, message, state);
            state.walletInfo = walletInfo;

            // Generate structured content from natural language
            const balanceContext = composeContext({
                state,
                template: getbalanceTemplate,
            });

            const content = await generateObject({
                runtime,
                context: balanceContext,
                modelClass: ModelClass.LARGE,
            });

            console.log("Generated content:", content);

            // Validate the generated content
            if (!isGetBalanceContent(content)) {
                throw new Error("Invalid content structure for getbalance action");
            }

            const walletProvider = new WalletProvider(runtime);
            await walletProvider.switchChain(runtime, content.chain);
            const address = walletProvider.getAddress();
            let balance: string;
            let symbol: string;

            if (content.tokenAddress) {
                // Get ERC20 balance
                const publicClient = walletProvider.getPublicClient(content.chain);
                const tokenBalance = await publicClient.readContract({
                    address: content.tokenAddress,
                    abi: erc20Abi,
                    functionName: 'balanceOf',
                    args: [address]
                });

                // Get token symbol and decimals if not provided
                const tokenSymbol = await publicClient.readContract({
                    address: content.tokenAddress,
                    abi: erc20Abi,
                    functionName: 'symbol'
                });

                const decimals = content.decimals ?? await publicClient.readContract({
                    address: content.tokenAddress,
                    abi: erc20Abi,
                    functionName: 'decimals'
                });

                balance = formatUnits(tokenBalance as bigint, decimals as number);
                symbol = tokenSymbol as string;
            } else {
                // Get native token (ETH) balance
                balance = await walletProvider.getWalletBalance() ?? "0";
                symbol = "ETH";
            }

            if (callback) {
                callback({
                    text: `Your ${symbol} balance on ${content.chain} is ${balance} ${symbol} (Address: ${address})`
                });
            }

            return true;
        } catch (error) {
            console.error("Error in getbalance handler:", error);
            if (callback) {
                callback({ text: `Error: ${error.message}` });
            }
            return false;
        }
    },
    template: getbalanceTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Check my balance on Sepolia",
                    action: "GET_BALANCE",
                },
            },
        ],
        [
            {
                user: "user",
                content: {
                    text: "What's my ETH balance?",
                    action: "GET_BALANCE",
                },
            },
        ],
    ],
    similes: ["GET_BALANCE", "CHECK_BALANCE", "WALLET_BALANCE"],
};