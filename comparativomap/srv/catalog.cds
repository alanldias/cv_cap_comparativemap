using comparativemap as comparativemap from '../db/schema';

service catalog {
    entity Client as projection on comparativemap.Client;    
}