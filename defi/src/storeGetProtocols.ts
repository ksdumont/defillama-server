import { craftProtocolsResponse } from "./getProtocols";
import { wrapScheduledLambda } from "./utils/shared/wrap";
import { constants, brotliCompressSync } from "zlib";
import { getProtocolTvl } from "./utils/getProtocolTvl";
import parentProtocolsList from "./protocols/parentProtocols";
import type { IParentProtocol } from "./protocols/types";
import type { IProtocol, LiteProtocol, ProtocolTvls } from "./types";
import { storeR2 } from "./utils/r2";
import { getChainDisplayName } from "./utils/normalizeChain";

function compress(data: string) {
  return brotliCompressSync(data, {
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
  });
}

function replaceChainNames(
  oraclesByChain?:
    | {
        [chain: string]: string[];
      }
    | undefined
) {
  if (!oraclesByChain) return oraclesByChain;
  return Object.fromEntries(
    Object.entries(oraclesByChain).map(([chain, vals]) => [getChainDisplayName(chain, true), vals])
  );
}

const handler = async (_event: any) => {
  const response = await craftProtocolsResponse(true);

  const trimmedResponse: LiteProtocol[] = (
    await Promise.all(
      response.map(async (protocol: IProtocol) => {
        const protocolTvls: ProtocolTvls = await getProtocolTvl(protocol, true);
        return {
          category: protocol.category,
          chains: protocol.chains,
          oracles: protocol.oracles,
          oraclesByChain: replaceChainNames(protocol.oraclesByChain),
          forkedFrom: protocol.forkedFrom,
          listedAt: protocol.listedAt,
          mcap: protocol.mcap,
          name: protocol.name,
          symbol: protocol.symbol,
          logo: protocol.logo,
          url: protocol.url,
          referralUrl: protocol.referralUrl,
          tvl: protocolTvls.tvl,
          tvlPrevDay: protocolTvls.tvlPrevDay,
          tvlPrevWeek: protocolTvls.tvlPrevWeek,
          tvlPrevMonth: protocolTvls.tvlPrevMonth,
          chainTvls: protocolTvls.chainTvls,
          parentProtocol: protocol.parentProtocol,
          defillamaId: protocol.id,
          governanceID: protocol.governanceID,
        };
      })
    )
  ).filter((p) => p.category !== "Chain" && p.category !== "CEX");

  const chains = {} as { [chain: string]: number };
  const protocolCategoriesSet: Set<string> = new Set();

  trimmedResponse.forEach((p) => {
    if (!p.category) return;

    protocolCategoriesSet.add(p.category);
    if (p.category !== "Bridge" && p.category !== "RWA") {
      p.chains.forEach((c: string) => {
        chains[c] = (chains[c] ?? 0) + (p.chainTvls[c]?.tvl ?? 0);

        if (p.chainTvls[`${c}-liquidstaking`]) {
          chains[c] = (chains[c] ?? 0) - (p.chainTvls[`${c}-liquidstaking`]?.tvl ?? 0);
        }

        if (p.chainTvls[`${c}-doublecounted`]) {
          chains[c] = (chains[c] ?? 0) - (p.chainTvls[`${c}-doublecounted`]?.tvl ?? 0);
        }

        if (p.chainTvls[`${c}-dcAndLsOverlap`]) {
          chains[c] = (chains[c] ?? 0) + (p.chainTvls[`${c}-dcAndLsOverlap`]?.tvl ?? 0);
        }
      });
    }
  });

  const coinMarkets = await fetch("https://coins.llama.fi/mcaps", {
    method: "POST",
    body: JSON.stringify({
      coins: parentProtocolsList
        .filter((parent) => typeof parent.gecko_id === "string")
        .map((parent) => `coingecko:${parent.gecko_id}`),
    }),
  }).then((r) => r.json());

  const extendedParentProtocols = [] as any[]
  const parentProtocols: IParentProtocol[] = parentProtocolsList.map((parent) => {
    const chains: Set<string> = new Set();

    const children = response.filter((protocol) => protocol.parentProtocol === parent.id);
    let symbol = '-', tvl = 0, chainTvls = {} as {[chain:string]:number}
    children.forEach((child) => {
      if(child.symbol !== "-"){
        symbol = child.symbol
      }
      tvl += child.tvl;
      Object.entries(child.chainTvls).forEach(([chain, chainTvl])=>{
        chainTvls[chain] = (chainTvls[chain] ?? 0) + chainTvl
      })
      child.chains?.forEach((chain: string) => chains.add(chain));
    });

    const mcap = parent.gecko_id ? coinMarkets?.[`coingecko:${parent.gecko_id}`]?.mcap ?? null : null
    extendedParentProtocols.push({
      id: parent.id,
      name: parent.name,
      symbol,
      //category,
      tvl,
      chainTvls,
      mcap,
      isParent: true,
    })
    return {
      ...parent,
      chains: Array.from(chains),
      mcap,
    };
  });

  const compressedV2Response = compress(
    JSON.stringify({
      protocols: trimmedResponse,
      chains: Object.entries(chains)
        .sort((a, b) => b[1] - a[1])
        .map((c) => c[0]),
      protocolCategories: [...protocolCategoriesSet].filter((category) => category),
      parentProtocols,
    })
  );
  await storeR2("lite/protocols2", compressedV2Response, true);
  const dummyProtocols = response.filter(p=>p.module==="dummy.js").reduce((acc, curr)=>({...acc, [curr.id]:true}), {} as {[id:string]:boolean})
  await storeR2("lite/v2/protocols", JSON.stringify(trimmedResponse.filter(p=>dummyProtocols[p.defillamaId] === undefined).map(protocol=>({
    id: protocol.defillamaId,
    name: protocol.name,
    symbol: protocol.symbol,
    category: protocol.category,
    tvl: protocol.tvl,
    chainTvls: protocol.chainTvls,
    mcap: protocol.mcap,
    parent: protocol.parentProtocol,
  })).concat(extendedParentProtocols)), true, false);
};

export default wrapScheduledLambda(handler);
