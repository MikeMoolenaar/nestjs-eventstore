
export interface IEventMetaData{
  eventName: string;
  streamMetaData?: any;
  eventNumber: number;
  eventId: string;
  eventStreamId: string;
  dateCreated: Date;
}
