import type { ClassId } from "@jlw/contracts";

export type ClassBinding = { playerId:string; teamId:string; classId:ClassId; bound:boolean };
export interface ClassRepository {
  find(playerId:string): Promise<ClassBinding|undefined>;
  classTaken(teamId:string,classId:ClassId,exceptPlayerId:string): Promise<boolean>;
  bind(playerId:string,classId:ClassId): Promise<void>;
  correctAndAudit(input:{playerId:string;previousClass:ClassId;newClass:ClassId;gmId:string;reason:string}): Promise<void>;
}
export class ClassService {
  constructor(private readonly repository:ClassRepository) {}
  async choose(playerId:string,classId:ClassId):Promise<void> { const player=await this.repository.find(playerId); if(!player)throw new Error("PLAYER_NOT_FOUND"); if(player.bound)throw new Error("CLASS_PERMANENTLY_BOUND"); if(await this.repository.classTaken(player.teamId,classId,playerId))throw new Error("CLASS_ALREADY_TAKEN"); await this.repository.bind(playerId,classId); }
  async gmCorrect(playerId:string,newClass:ClassId,gmId:string,reason:string):Promise<void> { if(!reason.trim())throw new Error("AUDIT_REASON_REQUIRED"); const player=await this.repository.find(playerId); if(!player)throw new Error("PLAYER_NOT_FOUND"); if(await this.repository.classTaken(player.teamId,newClass,playerId))throw new Error("CLASS_ALREADY_TAKEN"); await this.repository.correctAndAudit({playerId,previousClass:player.classId,newClass,gmId,reason}); }
}
