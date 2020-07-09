
export interface IEventMetaData{
  eventName: string;
  streamMetaData?: any;
  eventNumber: Long;
  eventId: string;
  eventStreamId: string;
  dateCreated: Date;
}
