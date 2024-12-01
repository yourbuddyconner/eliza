import {
    IAgentRuntime,
    Memory,
    State,
    ModelClass,
    generateObject,
    composeContext,
    stringToUuid,
    elizaLogger
} from "@ai16z/eliza";
import { getTokenInfoAction } from "@ai16z/plugin-evm";
import { SwapAction } from "@ai16z/plugin-evm";
import { WalletProvider as WalletProviderClass, type WalletProvider } from "@ai16z/plugin-evm";

interface TokenAnalysis {
    address: string;
    symbol: string;
    priceUSD: string;
    marketCap: string;
    recommendation: 'buy' | 'sell' | 'hold';
    confidence: number;
    reason: string;
}

interface TokenDiscoveryResult {
    address: string;
    name: string;
    symbol: string;
    chain: string;
    marketCap?: string;
    volume24h?: string;
    priceChange24h?: string;
    liquidity?: string;
    txCount24h?: number;
    dex?: string;
    quoteToken?: string;
}

export class AutoClientInterface {
    private interval: NodeJS.Timeout;
    private runtime: IAgentRuntime;
    private walletProvider: InstanceType<typeof WalletProviderClass>;
    private roomId: string;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.walletProvider = new WalletProviderClass(runtime);
        this.roomId = `auto-trader-${runtime.character.id}`;
    }

    static async start(runtime: IAgentRuntime) {
        const client = new AutoClientInterface(runtime);
        await client.initialize();
        return client;
    }

    async initialize() {
        elizaLogger.info(`Initializing auto trader for ${this.runtime.character.name}`);
        this.interval = setInterval(
            () => this.makeTrades(),
            60 * 60 * 1000
        );
        await this.makeTrades();
    }

    private async getTokenAnalysis(tokenAddress: string, chain: string): Promise<TokenAnalysis | null> {
        try {
            elizaLogger.info(`\n Starting Analysis for ${tokenAddress} on ${chain}`);
            elizaLogger.info("├── Validating address...");

            if (!tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
                elizaLogger.warn("└── ❌ Invalid token address format");
                return null;
            }
            elizaLogger.info("├── ✅ Address valid");

            elizaLogger.info("├── Fetching token info...");
            const memory: Memory = {
                id: stringToUuid(`analysis-${Date.now()}`),
                roomId: stringToUuid(this.roomId),
                createdAt: Date.now(),
                userId: stringToUuid(this.runtime.character.id),
                agentId: stringToUuid(this.runtime.character.id),
                content: {
                    text: `Get info about token ${tokenAddress} on ${chain}`,
                    action: "GET_TOKEN_INFO"
                }
            };

            const tokenInfo = await getTokenInfoAction.handler(
                this.runtime,
                null,
                null,
                {
                    chain,
                    tokenAddress,
                    skipParsing: true
                }
            );

            if (!tokenInfo) {
                elizaLogger.error("└── ❌ Failed to get token info");
                throw new Error("Failed to get token info");
            }

            elizaLogger.info("├── Token Data:");
            elizaLogger.info(`│   ├── Name: ${tokenInfo.name}`);
            elizaLogger.info(`│   ├── Symbol: ${tokenInfo.symbol}`);
            elizaLogger.info(`│   ├── Price: $${tokenInfo.priceUSD || '0'}`);
            elizaLogger.info(`│   └── Market Cap: $${tokenInfo.marketCap || '0'}`);

            elizaLogger.info("├── Analyzing metrics...");
            const priceUSD = parseFloat(tokenInfo.priceUSD || '0');
            const marketCap = parseFloat(tokenInfo.marketCap || '0');

            const analysis = {
                recommendation: (
                    marketCap > 1000000 && marketCap < 1000000000 ? 'buy' :
                    marketCap > 1000000000 ? 'hold' : 'sell'
                ) as 'buy' | 'sell' | 'hold',
                confidence: 0.85,
                reason: `Market cap ${marketCap > 1000000000 ? 'too high' :
                        marketCap < 1000000 ? 'too low' : 'in sweet spot'}`
            };

            elizaLogger.info("├── Analysis Results:");
            elizaLogger.info(`│   ├── Recommendation: ${analysis.recommendation.toUpperCase()}`);
            elizaLogger.info(`│   ├── Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
            elizaLogger.info(`│   └── Reason: ${analysis.reason}`);
            elizaLogger.info("└── ✅ Analysis complete\n");

            return {
                address: tokenAddress,
                symbol: tokenInfo.symbol,
                priceUSD: tokenInfo.priceUSD || '0',
                marketCap: tokenInfo.marketCap || '0',
                ...analysis
            };

        } catch (error) {
            elizaLogger.error(`└── ❌ Error analyzing token ${tokenAddress}:`, error);
            return null;
        }
    }

    // Add chain mapping
    CHAIN_ID_MAP: Record<string, string> = {
        "1": "ethereum",
        "8453": "base",
        "11155111": "sepolia",
        "eth": "ethereum",
        "base": "base",
        "ethereum": "ethereum"
    };

    private async discoverTokensFromDexScreener(): Promise<TokenDiscoveryResult[]> {
        elizaLogger.info("🔍 Discovering tokens from DexScreener...");
        try {
            const baseTokens = ["USDC", "WETH", "USDT", "DAI", "ETH"];
            let allPairs: any[] = [];

            // First get initial pairs
            for (const baseToken of baseTokens) {
                try {
                    elizaLogger.debug(`Searching pairs with ${baseToken}...`);
                    const response = await fetch(
                        "https://api.dexscreener.com/latest/dex/search?" +
                        new URLSearchParams({ q: baseToken })
                    );
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    const data = await response.json();
                    if (!data.pairs) {
                        elizaLogger.warn(`No pairs found for ${baseToken}`);
                        continue;
                    }
                    allPairs = [...allPairs, ...data.pairs];
                } catch (error) {
                    elizaLogger.error(`Failed to fetch pairs for ${baseToken}:`, error);
                }
            }

            elizaLogger.success(`Found ${allPairs.length} initial pairs`);
            if (allPairs.length === 0) {
                throw new Error("No pairs found in initial search");
            }

            // Extract and batch addresses
            const uniqueAddresses = new Set<string>();
            allPairs.forEach(pair => {
                if (pair?.baseToken?.address?.startsWith('0x')) {
                    uniqueAddresses.add(pair.baseToken.address);
                }
                if (pair?.quoteToken?.address?.startsWith('0x')) {
                    uniqueAddresses.add(pair.quoteToken.address);
                }
            });

            elizaLogger.info(`Found ${uniqueAddresses.size} unique addresses`);

            // Process in batches with delay
            const tokens: TokenDiscoveryResult[] = [];
            const batchSize = 20; // Reduce batch size
            const addresses = Array.from(uniqueAddresses);

            for (let i = 0; i < addresses.length; i += batchSize) {
                const batch = addresses.slice(i, i + batchSize);
                try {
                    elizaLogger.debug(`Processing batch ${i/batchSize + 1}/${Math.ceil(addresses.length/batchSize)}`);
                    const response = await fetch(
                        `https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`
                    );
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    const data = await response.json();

                    if (!data.pairs) {
                        elizaLogger.warn(`No data returned for batch ${i/batchSize + 1}`);
                        continue;
                    }

                    for (const pair of data.pairs) {
                        if (!pair?.baseToken?.address) continue;

                        const mappedChain = this.CHAIN_ID_MAP[pair.chainId];
                        if (!mappedChain) {
                            elizaLogger.debug(`Skipping unsupported chain: ${pair.chainId}`);
                            continue;
                        }

                        tokens.push({
                            address: pair.baseToken.address,
                            name: pair.baseToken.name || 'Unknown',
                            symbol: pair.baseToken.symbol || 'Unknown',
                            chain: mappedChain,
                            marketCap: pair.marketCap?.toString() || '0',
                            volume24h: (pair.volume?.h24 || 0).toString(),
                            priceChange24h: (pair.priceChange?.h24 || 0).toString(),
                            liquidity: (pair.liquidity?.usd || 0).toString(),
                            txCount24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
                            dex: pair.dexId || 'unknown'
                        });
                    }

                    // Add delay between batches
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    elizaLogger.error(`Failed to process batch ${i/batchSize + 1}:`, error);
                }
            }

            elizaLogger.info(`Successfully processed ${tokens.length} tokens`);
            return tokens;
        } catch (error) {
            elizaLogger.error("❌ Error discovering tokens from DexScreener:", error);
            return [];
        }
    }

    private async filterPromising(tokens: TokenDiscoveryResult[]): Promise<string[]> {
        elizaLogger.info("🎯 Filtering promising tokens...");
        elizaLogger.info("\nToken Analysis Results:");
        elizaLogger.info("┌─────────────┬────────────┬────────────┬──────────┬──────────┐──────────┐");
        elizaLogger.info("│ Token       │ Pair       │ Volume 24h │ Liquidity│ Price Δ  │ Result   │");
        elizaLogger.info("├─────────────┼────────────┼────────────┼──────────┼──────────┼──────────┤");

        const promising = tokens.filter(token => {
            if (!token.volume24h || !token.priceChange24h || !token.liquidity) {
                elizaLogger.debug(`Skipping ${token.symbol} - Missing required metrics`);
                return false;
            }

            const volume24h = parseFloat(token.volume24h);
            const priceChange24h = parseFloat(token.priceChange24h);
            const liquidity = parseFloat(token.liquidity);

            const metrics = {
                volume: volume24h > 100000,
                liquidity: liquidity > 250000,
                priceActionPositive: priceChange24h > 1,
                priceActionSafe: priceChange24h < 30
            };

            // Format values for table
            const volumeStr = `$${(volume24h/1000000).toFixed(1)}M`;
            const liquidityStr = `$${(liquidity/1000000).toFixed(1)}M`;
            const priceStr = `${priceChange24h.toFixed(1)}%`;
            const result = Object.values(metrics).every(v => v) ? '✅ PASS' : ' FAIL';
            const pairStr = `${token.symbol}/${token.dex}`; // Use dex as quote token info

            // Pad strings for table alignment
            const symbol = token.symbol.padEnd(10).slice(0, 10);
            const pair = pairStr.padEnd(9).slice(0, 9);
            const volPad = volumeStr.padEnd(9);
            const liqPad = liquidityStr.padEnd(8);
            const pricePad = priceStr.padEnd(7);
            const resultPad = result.padEnd(8);

            elizaLogger.info(
                `│ ${symbol} │ ${pair} │ ${volPad} │ ${liqPad} │ ${pricePad} │ ${resultPad} │`
            );

            const isPromising = Object.values(metrics).every(v => v);
            if (isPromising) {
                elizaLogger.info(`🌟 ${token.symbol} meets all criteria`);
            }
            return isPromising;
        });

        elizaLogger.info("└─────────────┴────────────┴────────────┴──────────┴──────────┘──────────┘");
        elizaLogger.info(`\n✨ Found ${promising.length} promising tokens out of ${tokens.length} candidates\n`);

        return promising.map(t => t.address);
    }

    private async getHighTrustRecommendations(): Promise<string[]> {
        const dexScreenerTokens = await this.discoverTokensFromDexScreener();

        // Get additional data for each token
        const enrichedTokens: TokenDiscoveryResult[] = [];
        for (const token of dexScreenerTokens) {
            try {
                // Get all pairs for this token to analyze total liquidity
                const response = await fetch(
                    `https://api.dexscreener.com/latest/dex/tokens/${token.address}`
                );
                const data = await response.json();

                // Calculate total liquidity across all pairs
                const totalLiquidity = data.pairs?.reduce((sum: number, pair: any) =>
                    sum + (pair.liquidity?.usd || 0), 0);

                enrichedTokens.push({
                    ...token,
                    liquidity: totalLiquidity.toString()
                });
            } catch (error) {
                elizaLogger.warn(`Failed to enrich data for ${token.symbol}:`, error);
                enrichedTokens.push(token);
            }
        }

        elizaLogger.info(`📊 Found ${enrichedTokens.length} tokens with good metrics`);
        return this.filterPromising(enrichedTokens);
    }

    private async analyzeTokens(tokens: string[]): Promise<TokenAnalysis[]> {
        const analyses = await Promise.all(
            tokens.map(address => this.getTokenAnalysis(address, "ethereum"))
        );

        return analyses.filter((analysis): analysis is TokenAnalysis => analysis !== null);
    }

    private async executeTrades(analyses: TokenAnalysis[]) {
        const swapAction = new SwapAction(this.walletProvider);

        for (const analysis of analyses) {
            if (analysis.recommendation === 'buy' && analysis.confidence > 0.8) {
                try {
                    elizaLogger.info(`Executing buy for ${analysis.symbol} (confidence: ${analysis.confidence})`);
                    await swapAction.swap({
                        chain: "ethereum",
                        fromToken: "0x0000000000000000000000000000000000000000",
                        toToken: analysis.address as `0x${string}`,
                        amount: "0.1",
                        slippage: 50
                    });
                    elizaLogger.success(`Successfully bought ${analysis.symbol}`);
                } catch (error) {
                    elizaLogger.error(`Trade execution failed for ${analysis.symbol}:`, error);
                }
            }
        }
    }

    async makeTrades() {
        elizaLogger.info("🔄 Starting automated trading cycle...");
        try {
            elizaLogger.debug("📋 Getting token recommendations...");
            const recommendations = await this.getHighTrustRecommendations();
            elizaLogger.info(`📝 Analyzing ${recommendations.length} tokens...`);

            const analyses = await this.analyzeTokens(recommendations);
            elizaLogger.info(`✅ Analysis complete. Found ${analyses.length} valid results`);

            const tradableTokens = analyses.filter(a => a.recommendation === 'buy' && a.confidence > 0.8);
            elizaLogger.info(`🎯 Found ${tradableTokens.length} potential trades`);

            await this.executeTrades(analyses);
            elizaLogger.success("🏁 Trading cycle completed successfully");
        } catch (error) {
            elizaLogger.error("❌ Error in trading cycle:", error);
        }
    }

    stop() {
        elizaLogger.info("Stopping auto trader...");
        if (this.interval) {
            clearInterval(this.interval);
            elizaLogger.success("Auto trader stopped successfully");
        }
    }
}
