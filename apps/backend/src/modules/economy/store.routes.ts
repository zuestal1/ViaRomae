import type { FastifyInstance } from "fastify";
import { StoreCatalogResponseSchema, StorePurchaseRequestSchema, StoreSaleRequestSchema, StoreTransactionResponseSchema } from "@jlw/contracts";
import { getStoreCatalog, purchaseStoreItem, sellStoreItem } from "./store.service.js";

export async function storeRoutes(server: FastifyInstance) {
  server.get("/:storeId", { onRequest:[server.authenticate] }, async (request, reply) => {
    try { const {sub}=request.user as {sub:string}; const {storeId}=request.params as {storeId:string}; return reply.send(StoreCatalogResponseSchema.parse(await getStoreCatalog(sub,storeId))); }
    catch(error){ const e=error as Error&{statusCode?:number}; return reply.status(e.statusCode??500).send({message:e.message}); }
  });
  server.post("/:storeId/buy", { onRequest:[server.authenticate] }, async (request,reply)=>{
    const body=StorePurchaseRequestSchema.safeParse(request.body); if(!body.success)return reply.status(400).send({message:"Ungültiger Kauf.",errors:body.error.flatten()});
    try { const {sub}=request.user as {sub:string}; const {storeId}=request.params as {storeId:string}; return reply.send(StoreTransactionResponseSchema.parse(await purchaseStoreItem(sub,storeId,body.data))); }
    catch(error){const e=error as Error&{statusCode?:number};return reply.status(e.statusCode??500).send({message:e.message});}
  });
  server.post("/:storeId/sell", { onRequest:[server.authenticate] }, async (request,reply)=>{
    const body=StoreSaleRequestSchema.safeParse(request.body); if(!body.success)return reply.status(400).send({message:"Ungültiger Verkauf.",errors:body.error.flatten()});
    try { const {sub}=request.user as {sub:string}; const {storeId}=request.params as {storeId:string}; return reply.send(StoreTransactionResponseSchema.parse(await sellStoreItem(sub,storeId,body.data))); }
    catch(error){const e=error as Error&{statusCode?:number};return reply.status(e.statusCode??500).send({message:e.message});}
  });
}
