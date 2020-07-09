import { IEvent } from '@nestjs/cqrs';
import { IEventMetaData } from './event.interface';

export interface IEventHandler<T extends IEvent = any> {
  handle(event: T, incommingEvent: IEventMetaData): any;
}
